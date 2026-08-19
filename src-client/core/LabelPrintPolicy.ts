/* ============================================================================
   LABELPRINTPOLICY — MATRICE DE VISIBILITÉ CONTEXTUELLE de la modale
   d'impression d'étiquettes (retours terrain 2026-08-20 sur le lot E).
   Documentation : docs/qr-scan.md § « Étiquettes imprimables ».

   POURQUOI UN MODULE PUR : la modale livrée montrait « tous les contrôles dans
   tous les contextes » — la règle « quels contrôles pour (sujet, contenu,
   format) ? » était éparpillée dans le rendu DOM, donc invérifiable. Ici elle
   est écrite UNE fois, sous forme de DÉCISIONS pures (testées dans
   Tests/modules/test-labels.js) ; `ui/LabelPrintDialog` ne fait plus
   qu'APPLIQUER le verdict (poser `hidden`), jamais le calculer.

   LA MATRICE (le script de la maquette qr-etiquettes-imprimables fait foi —
   `sizeSel` par contexte, options `data-cable`, `customRow`/`cdL`/`clL`
   cachés, `colSet` caché en unitaire — durcie par les retours terrain) :

     · CONTENUS : les manchons (repère complet / identifiant seul) n'existent
       que pour les câbles et les faisceaux — un équipement ne s'enroule pas.
     · FORMATS : « Câble — drapeau » = câbles/faisceaux SEULEMENT ; « Baie »
       (100 × 60, tête de baie) = baies SEULEMENT (un équipement qui veut du
       100 × 60 passe par « Personnalisé ») ; câbles/faisceaux n'ont que
       drapeau + personnalisé (un rectangle S/M/L ne s'attache pas à un brin).
     · COTES mm : Larg./Haut. SEULEMENT sous « Personnalisé » ; la cote de QR
       quand elle est LIBRE (QR seul, drapeau, personnalisé) ; Ø/longueur
       SEULEMENT pour les manchons.
     · INFORMATIONS ADDITIONNELLES : cases limitées à ce que le SUJET possède —
       emplacement/type/série/propriétaire pour un équipement (owner = lot E1,
       le champ n'existe QUE sur les équipements), pas de n° de série sur une
       baie (le modèle n'en a pas), extrémités A/B + type pour câble/faisceau.
       En « QR seul » ne survit que le propriétaire (bande sous le carré) ;
       en « identifiant seul » plus rien (c'est le principe du contenu).
     · PLANCHE : à partir de 2 étiquettes seulement.

   MÉMOIRE DE SESSION : les réglages sont mémorisés PAR contexte, mais un
   réglage hérité peut devenir INVALIDE (ancienne UI plus permissive, futur
   partage de contexte…) — `sanitize` fait RETOMBER proprement sur le défaut
   du contexte plutôt que de laisser un état inatteignable par l'UI.
   ============================================================================ */

import type { LabelSizeId, LabelContentId } from "./LabelLayout";

/** Familles de sujets d'étiquette — une entrée par point d'entrée de l'app.
    `bundle` (faisceau/trunk) partage l'anatomie du câble : id + extrémités
    A/B (les deux patchs, cf. docs/faisceaux.md) = le même drapeau. */
export type LabelPrintKind = "equipment" | "rack" | "cable" | "bundle" | "spare";

/** Cases « Informations additionnelles » offertes/affichées (sous-ensemble de LabelFields). */
export interface LabelFieldOffer {
  location: boolean;
  type: boolean;
  serial: boolean;
  owner: boolean;
}

/** Verdict de visibilité pour un état (sujet, contenu, format, nombre) — consommé tel quel par l'UI. */
export interface LabelControlsVisibility {
  /** Intitulé de la section format : format / taille du QR (QR seul) / manchon. */
  header: "format" | "qrSize" | "sleeve";
  showSizeSelect: boolean;
  /** Cotes libres Larg./Haut. (mm) — personnalisé seulement. */
  showWidthHeight: boolean;
  /** Cote du QR (mm) — quand elle est LIBRE (QR seul, drapeau, personnalisé). */
  showQrMm: boolean;
  /** Ø du câble + longueur le long du câble — manchons seulement. */
  showDiaLen: boolean;
  /** La rangée mm entière (agrégat des trois précédents). */
  showMmRow: boolean;
  /** Rangée « Identifiant (toujours) » + section entière. */
  showIdRow: boolean;
  showFieldsSection: boolean;
  /** Cases affichées DANS la section (∩ de l'offre du sujet et des règles du contenu). */
  fields: LabelFieldOffer;
  /** Le libellé « Emplacement » devient « Extrémités A / B » (câble/faisceau). */
  locationAsEnds: boolean;
  /** Section Planche (colonnes + traits de coupe) — ≥ 2 étiquettes. */
  showSheetSection: boolean;
}

export class LabelPrintPolicy {
  /* ------------------------------- offres par sujet ------------------------------- */

  /** Un sujet « à drapeau » (câble/faisceau) — même anatomie, mêmes contenus. */
  static isFlagKind(kind: LabelPrintKind): boolean { return kind === "cable" || kind === "bundle"; }

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
    if (kind === "spare") return "s";
    return "m";
  }

  /** Taille de QR par défaut (mm) — celle du gabarit par défaut du contexte. */
  static defaultQrFor(kind: LabelPrintKind): number { return LabelPrintPolicy.isFlagKind(kind) ? 18 : 20; }

  /** Colonnes de planche par défaut (maquette : 3 pour les drapeaux, 4 sinon). */
  static defaultColsFor(kind: LabelPrintKind): number { return LabelPrintPolicy.isFlagKind(kind) ? 3 : 4; }

  /** Cases OFFERTES par sujet — uniquement ce que l'enregistrement POSSÈDE
      (cf. LabelSubjects : une case sans donnée serait un mensonge d'interface) :
        · équipement : emplacement, type, n° de série, propriétaire (lot E1) ;
        · spare      : emplacement (stockage), type, n° de série — owner n'existe pas ;
        · baie       : emplacement (salle), type (« Baie NU ») — ni série ni owner ;
        · câble/faisceau : extrémités A/B (= location), type — ni série ni owner. */
  static offeredFieldsFor(kind: LabelPrintKind): LabelFieldOffer {
    if (LabelPrintPolicy.isFlagKind(kind)) return { location: true, type: true, serial: false, owner: false };
    if (kind === "rack") return { location: true, type: true, serial: false, owner: false };
    if (kind === "spare") return { location: true, type: true, serial: true, owner: false };
    return { location: true, type: true, serial: true, owner: true };
  }

  /** Cases COCHÉES au premier tirage d'un contexte (défauts maquette : emplacement
      partout, type d'office pour câble/faisceau/baie, owner DÉCOCHÉ — décision E). */
  static defaultFieldsFor(kind: LabelPrintKind): LabelFieldOffer {
    const offered = LabelPrintPolicy.offeredFieldsFor(kind);
    return {
      location: offered.location,
      type: offered.type && (LabelPrintPolicy.isFlagKind(kind) || kind === "rack"),
      serial: false,
      owner: false,
    };
  }

  /* --------------------------------- le verdict --------------------------------- */

  /** LA matrice : quels contrôles pour (sujet, contenu, format, nombre d'étiquettes). */
  static visibility(kind: LabelPrintKind, content: LabelContentId, size: LabelSizeId, count: number): LabelControlsVisibility {
    const sleeve = content === "strip" || content === "id";
    const qrOnly = content === "qr";
    const qrFree = qrOnly || size === "cable" || size === "custom";   // la cote de QR est LIBRE (sinon le préréglage l'impose)
    const offered = LabelPrintPolicy.offeredFieldsFor(kind);
    // Règles du CONTENU sur les cases : « QR seul » ne garde que le propriétaire
    // (bande sous le carré) ; « identifiant seul » ne garde rien.
    const fields: LabelFieldOffer = {
      location: offered.location && !qrOnly && content !== "id",
      type: offered.type && !qrOnly && content !== "id",
      serial: offered.serial && !qrOnly && !sleeve,
      owner: offered.owner && content !== "id",
    };
    const showIdRow = !qrOnly && content !== "id";
    return {
      header: sleeve ? "sleeve" : qrOnly ? "qrSize" : "format",
      showSizeSelect: !qrOnly && !sleeve,
      showWidthHeight: size === "custom" && !qrOnly && !sleeve,
      showQrMm: qrFree && !sleeve,
      showDiaLen: sleeve,
      showMmRow: sleeve || qrFree,
      showIdRow,
      fields,
      showFieldsSection: showIdRow || fields.location || fields.type || fields.serial || fields.owner,
      locationAsEnds: LabelPrintPolicy.isFlagKind(kind),
      showSheetSection: count >= 2,
    };
  }

  /* ------------------------------ retombée sur défaut ------------------------------ */

  /** Ramène des réglages MÉMORISÉS dans ce que le contexte OFFRE : un choix devenu
      invalide (contenu manchon hors câble, format drapeau sur un équipement, case
      d'un champ que le sujet ne possède pas…) RETOMBE sur le défaut du contexte —
      jamais d'état que l'UI ne sait plus représenter. Muté EN PLACE (l'objet de
      session est partagé par référence), rendu pour chaîner. */
  static sanitize<T extends { content: LabelContentId; size: LabelSizeId; fields: LabelFieldOffer }>(kind: LabelPrintKind, settings: T): T {
    if (!LabelPrintPolicy.contentsFor(kind).includes(settings.content)) settings.content = "full";
    if (!LabelPrintPolicy.sizesFor(kind).includes(settings.size)) settings.size = LabelPrintPolicy.defaultSizeFor(kind);
    const offered = LabelPrintPolicy.offeredFieldsFor(kind);
    if (!offered.location) settings.fields.location = false;
    if (!offered.type) settings.fields.type = false;
    if (!offered.serial) settings.fields.serial = false;
    if (!offered.owner) settings.fields.owner = false;
    return settings;
  }
}
