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
   ============================================================================ */

import type { LabelSizeId, LabelContentId } from "./LabelLayout";
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

/** Verdict de visibilité pour un état (sujet, contenu, format, nombre, offre) — consommé tel quel par l'UI. */
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
  /** Case STRUCTURELLE « Extrémités A / B » — sujets à drapeau, contenus à texte. */
  showEndsToggle: boolean;
  showFieldsSection: boolean;
  /** Ids des cases de l'OFFRE visibles sous ce contenu (la modale masque les autres). */
  visibleFieldIds: string[];
  /** Section Planche (colonnes + traits de coupe) — ≥ 2 étiquettes. */
  showSheetSection: boolean;
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

  /* --------------------------------- le verdict --------------------------------- */

  /** LA matrice : quels contrôles pour (sujet, contenu, format, nombre, offre de cases). */
  static visibility(kind: LabelPrintKind, content: LabelContentId, size: LabelSizeId, count: number, offer: readonly LabelFieldOffer[]): LabelControlsVisibility {
    const sleeve = content === "strip" || content === "id";
    const qrOnly = content === "qr";
    const qrFree = qrOnly || size === "cable" || size === "custom";   // la cote de QR est LIBRE (sinon le préréglage l'impose)
    const visibleFieldIds = (offer || []).filter((f) => LabelPrintPolicy.fieldVisible(f, content)).map((f) => f.id);
    const showIdRow = !qrOnly && content !== "id";
    // La bascule A/B suit la règle du modèle figé (« QR seul » et « identifiant seul »
    // ne portent pas de texte d'extrémité) — offerte aux seuls sujets à drapeau.
    const showEndsToggle = LabelPrintPolicy.isFlagKind(kind) && !qrOnly && content !== "id";
    return {
      header: sleeve ? "sleeve" : qrOnly ? "qrSize" : "format",
      showSizeSelect: !qrOnly && !sleeve,
      showWidthHeight: size === "custom" && !qrOnly && !sleeve,
      showQrMm: qrFree && !sleeve,
      showDiaLen: sleeve,
      showMmRow: sleeve || qrFree,
      showIdRow,
      showEndsToggle,
      visibleFieldIds,
      showFieldsSection: showIdRow || showEndsToggle || visibleFieldIds.length > 0,
      showSheetSection: count >= 2,
    };
  }

  /* ------------------------------ retombée sur défaut ------------------------------ */

  /** Ramène des réglages MÉMORISÉS dans ce que le contexte OFFRE : un choix devenu
      invalide (contenu manchon hors câble, format drapeau sur un équipement…) RETOMBE
      sur le défaut du contexte — jamais d'état que l'UI ne sait plus représenter.
      T10 : les cases mémorisées sont RÉCONCILIÉES avec l'offre du tirage courant —
      les ids qui n'y figurent plus sont retirés (la mémoire d'une case disparue ne
      doit pas resurgir sur un autre id un jour recyclé), les ids nouveaux prennent
      leur état coché DÉCLARÉ. Muté EN PLACE (l'objet de session est partagé par
      référence), rendu pour chaîner. */
  static sanitize<T extends { content: LabelContentId; size: LabelSizeId; fields: Record<string, boolean> }>(kind: LabelPrintKind, offer: readonly LabelFieldOffer[], settings: T): T {
    if (!LabelPrintPolicy.contentsFor(kind).includes(settings.content)) settings.content = "full";
    if (!LabelPrintPolicy.sizesFor(kind).includes(settings.size)) settings.size = LabelPrintPolicy.defaultSizeFor(kind);
    const offered = new Set((offer || []).map((f) => f.id));
    for (const id of Object.keys(settings.fields)) {
      if (!offered.has(id)) delete settings.fields[id];
    }
    for (const f of offer || []) {
      if (!(f.id in settings.fields)) settings.fields[f.id] = f.checked;
    }
    return settings;
  }
}
