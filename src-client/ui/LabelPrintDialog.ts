/* =============================================================================
   LABELPRINTDIALOG — LA modale d'impression des étiquettes QR (lot E du chantier
   étiquettes QR, REFONDUE par le retour terrain T11 du 2026-09-03).
   Documentation : docs/qr-scan.md § « Étiquettes imprimables ». La maquette
   design-system/briefs/qr-print-redesign-maquette.html FAIT FOI pour la
   structure du panneau ; celle de qr-etiquettes-imprimables fait toujours foi
   pour le RENDU IMPRIMÉ, qui n'a pas bougé.

   UN SEUL écran de sortie : ce dialogue. Ce qui change est ce qu'il REÇOIT
   (`LabelPrintContext`). Il s'ouvre dans la PILE DE MODALES STANDARD
   (principe n°11 — par-dessus la fiche appelante, ← y revient).

   DÉCOUPE INCHANGÉE : la géométrie est PURE (`core/LabelLayout`), les règles
   sont PURES (`core/LabelPrintPolicy`), le rendu HTML est PUR et PARTAGÉ
   aperçu ⇄ imprimé (`core/LabelHtml`), le SVG de QR est retravaillé PUREMENT
   (`core/LabelQrSvg`), le plan d'export est PUR (`core/LabelExportPlan`). Ici ne
   vivent que l'orchestration DOM, l'état de session et l'iframe d'impression.

   🚨 CE QUE T11 A CHANGÉ, ET POURQUOI. Le retour était : « le rendu imprimé
   n'est pas en cause — c'est le panneau qui a dérivé, onze drapeaux de
   visibilité plus tard ». Cinq déplacements, tous dans le PANNEAU :

     1. **QUATRE ÉTAGES QUI NE DISPARAISSENT JAMAIS** (contexte · ◈ Tirage ·
        ① Support · ② Contenu · ③ Informations additionnelles). Le vocabulaire
        de la modale ne bouge plus d'un sujet à l'autre. Le SEUL déplacement
        structurel est l'ORDRE : Tirage passe en tête dès que le tirage compte
        au moins deux étiquettes, parce qu'il devient alors la première question.
     2. **DISPONIBILITÉ AVEC RAISON au lieu de `hidden`.** Une option
        indisponible reste LISTÉE, `disabled`, avec sa raison lisible — c'est le
        panneau qui explique la règle, au lieu de la faire deviner. Les verdicts
        viennent tous de `LabelPrintPolicy.availability` : AUCUNE règle de
        disponibilité n'est écrite ici (verrou de test sur cette source).
        Les CASES de champ non déclarées restent, elles, ABSENTES (T10, décision
        Q10.C) : deux traitements, jamais trois.
     3. **L'axe SUPPORT remplace le fourre-tout « Format ».** On choisit
        l'OBJET PHYSIQUE (étiquette plate · tête de baie · drapeau · manchon) ;
        gabarit et contenu en découlent (`supportOf`/`applySupport`, projection
        pure — le modèle `LabelSpec` n'a pas bougé).
     4. **LE TIRAGE EST UNE DÉCISION DE LA MODALE.** « Un drapeau » vs « les 2
        extrémités » était tranché par le point d'entrée, avant même de voir
        l'aperçu : c'est maintenant la bascule A / B / A+B, doublée d'un
        multiplicateur d'occurrences, d'un choix de papier et d'une résolution.
        Les points d'entrée fusionnent (11 → 9), le panier passe UN sujet par
        élément et c'est `LabelPrintPolicy.expand` qui multiplie.
     5. **DEUX REGISTRES D'AVERTISSEMENT** au lieu d'un tas : « risque de scan »
        collé à l'aperçu (ça compromet l'objet), « conséquence de tirage » au
        pied (ça décrit ce qui va sortir). Imprimer reste TOUJOURS actif : on
        imprime pour son propre usage.

   🚨 MÉMOIRE DE SESSION VISIBLE (décision Q11.5) : les réglages restent
   mémorisés PAR contexte et JAMAIS persistés, mais le panneau le DIT (« repris
   de votre dernier tirage ») et offre « Revenir aux défauts ». Un réglage qu'on
   ne s'explique pas est un réglage qu'on subit.

   MODE LOCAL : l'impression d'étiquettes est MODE API SEULEMENT (génération
   serveur). Patron « injection nulle » (cf. AccessState/HydrationState) :
   `setup()` n'est appelé par main.ts QU'EN mode API — partout ailleurs
   `available()` rend faux et TOUTES les entrées d'impression restent masquées,
   sans le moindre test de mode dispersé.

   IMPRESSION : document print-CSS ISOLÉ dans une iframe cachée — noir sur
   blanc, aucun token de thème. ROULEAU = une page `@page` à la cote EXACTE par
   étiquette (imprimantes Brother/Dymo), même à N ; PLANCHE = A4, grille, traits
   de coupe. Les QR étant INLINE dans le document (SVG déjà en main), le
   `print()` n'attend que le `load` de l'iframe.
   ============================================================================= */

import type { ModalOptions } from "./Modal";
import { Dialog } from "./Dialog";
import { FormControls } from "./FormControls";
import { Icons } from "./Icons";
import { Html } from "../core/Html";
import { I18n } from "../i18n/I18n";
import { LabelLayout } from "../core/LabelLayout";
import type { LabelSpec, LabelSizeId, LabelContentId, LabelWarning, LabelDpi } from "../core/LabelLayout";
import { LabelHtml } from "../core/LabelHtml";
import type { LabelSubject } from "../core/LabelHtml";
import { LabelQrSvg } from "../core/LabelQrSvg";
import { LabelPrintPolicy } from "../core/LabelPrintPolicy";
import type {
  LabelPrintKind, LabelPrintSettings, LabelSupportId, LabelCoteId,
  LabelEndsMode, LabelPaperMode, LabelPrintItem,
} from "../core/LabelPrintPolicy";
import type { LabelQrMatrix } from "../core/LabelExportPlan";
import { LabelImageExport } from "./LabelImageExport";

/** Ce que la modale attend de l'application (câblé UNE fois par main.ts, MODE API seulement). */
export interface LabelPrintHost {
  openModal(opts: ModalOptions): void;
  /** SVG brut de la route `GET …/qr/:collection/:id?format=svg` (rejette si 4xx/5xx —
      le message serveur est actionnable : PUBLIC_BASE_URL absente → 503 explicite). */
  fetchQrSvg(collection: string, id: string): Promise<string>;
  /** MATRICE de modules (`?format=matrix`) — l'export en images dessine le QR depuis elle,
      à un nombre ENTIER de pixels par module, plutôt que de mettre le SVG à l'échelle
      (diagnostic Q11.14). Récupérée À LA DEMANDE : un tirage qu'on imprime sans exporter
      ne doit pas payer un aller serveur de plus par sujet. */
  fetchQrMatrix(collection: string, id: string): Promise<LabelQrMatrix>;
  /** `@font-face` de la fonte EMBARQUÉE (data: URI), posés dans l'aperçu ET dans le document
      d'impression — cf. `ui/LabelFontAssets`. INJECTÉ et non importé ici : les woff2 ne sont
      des chaînes que sous webpack, et ce fichier est aussi chargé sous Node par les tests. */
  fontCss?: string;
}

/** Contexte d'ouverture — ce qui change entre les points d'entrée. Le TYPE de sujet
    (`LabelPrintKind`, faisceaux compris) vit dans `core/LabelPrintPolicy` — ré-exporté ici
    pour les points d'entrée. */
export type { LabelPrintKind };
export interface LabelPrintContext {
  kind: LabelPrintKind;
  /** Les OBJETS à étiqueter — UN par objet depuis T11. Le nombre d'ÉTIQUETTES en découle
      (bascule A / B / A+B × occurrences, cf. `LabelPrintPolicy.expand`) : un câble n'arrive
      plus ici en double pour dire « les deux extrémités ». */
  subjects: LabelSubject[];
  /** Libellé de la source — sous-titre de la modale + en-tête de planche. */
  source: string;
  /** Défaut de la bascule d'extrémités proposé par le point d'entrée (le panier le tient de
      `CartLabelPlans`). N'a d'effet qu'au PREMIER tirage d'un contexte : ensuite la mémoire
      de session prime — c'est un défaut, pas une imposition. */
  defaultEndsMode?: LabelEndsMode;
}

export class LabelPrintDialog {
  private static host: LabelPrintHost | null = null;
  /** Réglages du dernier tirage, PAR contexte — durée de vie : la session de l'onglet. */
  private static readonly session = new Map<LabelPrintKind, LabelPrintSettings>();

  /** Câblage de l'hôte — appelé par main.ts UNIQUEMENT en mode API (injection nulle). */
  static setup(host: LabelPrintHost): void { LabelPrintDialog.host = host; }

  /** L'impression est-elle disponible ? FAUX en mode fichier/visualiseur (pas de
      setup) — le prédicat que TOUTES les entrées d'impression consultent. */
  static available(): boolean { return !!LabelPrintDialog.host; }

  /** Réglages du contexte : ceux de la session, ou des défauts frais. Rend aussi si la
      mémoire a servi — le panneau l'AFFICHE (décision Q11.5), il ne le devine pas. */
  private static settingsFor(kind: LabelPrintKind, defaultEndsMode?: LabelEndsMode): { settings: LabelPrintSettings; remembered: boolean } {
    const held = LabelPrintDialog.session.get(kind);
    if (held) return { settings: held, remembered: true };
    const fresh = LabelPrintPolicy.defaults(kind);
    if (defaultEndsMode) fresh.endsMode = defaultEndsMode;
    LabelPrintDialog.session.set(kind, fresh);
    return { settings: fresh, remembered: false };
  }

  /** Ouvre la modale d'impression. No-op si l'impression n'est pas disponible
      (les entrées sont masquées en amont — ceci n'est qu'une ceinture). */
  static open(ctx: LabelPrintContext): void {
    const host = LabelPrintDialog.host;
    const subjects = (ctx.subjects || []).filter(Boolean);
    if (!host || !subjects.length) return;
    const kind = ctx.kind;
    // L'OFFRE de cases du tirage = l'union des déclarations des sujets (T10 — une planche
    // hétérogène offre la réunion : un id déclaré par AU MOINS un sujet a sa case).
    const offer = LabelPrintPolicy.fieldOffer(subjects);
    const memory = LabelPrintDialog.settingsFor(kind, ctx.defaultEndsMode);
    let remembered = memory.remembered;
    // Réglages mémorisés RAMENÉS dans ce que le contexte offre (retombée sur défaut) et cases
    // RÉCONCILIÉES avec l'offre courante (ids disparus retirés, nouveaux au défaut déclaré).
    const st = LabelPrintPolicy.sanitize(kind, offer, memory.settings);
    const subjectCount = subjects.length;
    const longestId = subjects.reduce((max, s) => Math.max(max, (s.name || "").length), 0);
    const t = (key: string, vars?: Record<string, unknown>) => I18n.t("labels." + key, vars);
    const plural = (n: number) => (n > 1 ? "s" : "");

    /* ------------------------------- construction ------------------------------- */
    const root = document.createElement("div");
    root.className = "label-print";
    // CSS des étiquettes injectée UNE fois (scopée .label-render) : l'aperçu rend le
    // MÊME HTML que l'imprimé — fidélité par construction (cf. core/LabelHtml).
    const style = document.createElement("style");
    style.textContent = (host.fontCss || "") + LabelHtml.CSS;   // aperçu ET imprimé déclarent la MÊME fonte embarquée
    root.appendChild(style);

    const side = document.createElement("div"); side.className = "lp-side";
    const prev = document.createElement("div"); prev.className = "lp-preview";
    root.append(side, prev);

    const el = (tag: string, cls?: string, text?: string): HTMLElement => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    };
    /** Ligne d'explication d'un étage — le « pourquoi » que la maquette pose sous chaque bloc. */
    const why = (): HTMLElement => {
      const p = el("p", "lp-why");
      p.innerHTML = `<span class="gi" aria-hidden="true">${Icons.INFO}</span><span></span>`;   // SVG de confiance (ui/Icons)
      return p;
    };
    const setWhy = (node: HTMLElement, text: string): void => {
      const slot = node.querySelector("span:last-child") as HTMLElement;
      slot.textContent = text;
    };

    /* -- CONTEXTE : qui, combien, avec quelle mémoire (jamais masqué) -- */
    const ctxBox = el("div", "lp-ctx");
    const ctxWho = el("div", "lp-ctx-who");
    const ctxMeta = el("div", "lp-ctx-meta");
    const ctxMem = el("div", "lp-ctx-mem");
    const memText = el("span", "lp-ctx-memtext");
    const resetBtn = document.createElement("button");
    resetBtn.type = "button"; resetBtn.className = "btn btn-ghost btn-sm";
    resetBtn.textContent = t("dialog.resetDefaults");
    ctxMem.append(memText, resetBtn);
    ctxBox.append(ctxWho, ctxMeta, ctxMem);
    side.appendChild(ctxBox);

    /** Un ÉTAGE : numéro, titre, valeur courante à droite, puis son contenu. */
    const stage = (num: string, title: string): { box: HTMLElement; value: HTMLElement } => {
      const box = el("div", "lp-stage");
      const head = el("div", "lp-stage-head");
      head.append(el("span", "lp-stage-n", num), el("span", "lp-stage-t", title));
      const value = el("span", "lp-stage-v");
      head.appendChild(value);
      box.appendChild(head);
      return { box, value };
    };

    /* ============================ ◈ TIRAGE ============================ */
    const tirage = stage("◈", t("dialog.stageTirage"));
    const tirageGrid = el("div", "lp-grid");
    const numField = (label: string, input: HTMLInputElement): HTMLElement => {
      const wrap = document.createElement("label"); wrap.className = "lp-num";
      wrap.append(el("span", undefined, label), input);
      return wrap;
    };
    const occI = FormControls.number(st.occurrences, { min: LabelPrintPolicy.OCCURRENCES_MIN, max: LabelPrintPolicy.OCCURRENCES_MAX, step: 1 });
    tirageGrid.appendChild(numField(t("dialog.occurrences"), occI));
    tirage.box.appendChild(tirageGrid);

    const paperSeg = FormControls.segmented(
      [{ value: "sheet", label: t("dialog.paperSheet") }, { value: "roll", label: t("dialog.paperRoll") }],
      "sheet",
      (v) => { st.paper = v as LabelPaperMode; render(); },
      { ariaLabel: t("dialog.paper") },
    );
    const dpiSeg = FormControls.segmented(
      LabelPrintPolicy.DPIS.map((d) => ({ value: String(d), label: t("dialog.dpiValue", { dpi: d }) })),
      String(st.dpi),
      (v) => { st.dpi = (parseInt(v, 10) as LabelDpi); render(); },
      { ariaLabel: t("dialog.dpi") },
    );
    // COLONNES : contrôle SEGMENTÉ (la maquette), construit UNE fois sur toute la gamme que
    // l'interface accepte — seul l'état `disabled` bouge au rendu. Le recréer à chaque rendu
    // ferait perdre le focus au clavier ; le figer à 2/3/4 priverait des cas réels (une tête
    // de baie ne tient qu'en 1 colonne, un manchon en accepte 8).
    const colsSeg = FormControls.segmented(
      Array.from({ length: LabelLayout.MAX_SHEET_COLUMNS }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
      String(st.cols),
      (v) => { st.cols = parseInt(v, 10) || 1; render(); },
      { ariaLabel: t("dialog.cols") },
    );
    const colsButtons = [...colsSeg.querySelectorAll("button")] as HTMLButtonElement[];
    const densSeg = FormControls.segmented(
      [{ value: "compact", label: t("dialog.densityCompact") }, { value: "comfort", label: t("dialog.densityComfort") }],
      st.compact ? "compact" : "comfort",
      (v) => { st.compact = v === "compact"; render(); },
      { ariaLabel: t("dialog.density") },
    );
    const cutsToggle = FormControls.toggle(t("dialog.cuts"), st.cuts, (v) => { st.cuts = v; render(); }, { block: true });
    const labelled = (text: string, control: HTMLElement): HTMLElement => {
      const wrap = el("div", "lp-field");
      wrap.append(el("span", "lp-field-l", text), control);
      return wrap;
    };
    const paperRow = labelled(t("dialog.paper"), paperSeg);
    const dpiRow = labelled(t("dialog.dpi"), dpiSeg);
    const colsRow = labelled(t("dialog.cols"), colsSeg);
    const densRow = labelled(t("dialog.density"), densSeg);
    tirage.box.append(paperRow, dpiRow, colsRow, densRow, cutsToggle);
    const tirageWhy = why(); tirage.box.appendChild(tirageWhy);

    /* ============================ ① SUPPORT ============================ */
    const support = stage("①", t("dialog.stageSupport"));
    const SUPPORT_IDS: LabelSupportId[] = ["label", "rackhead", "flag", "sleeve"];
    const supportOpts = el("div", "lp-opts");
    /** Une option-carte : titre + ligne d'explication (le hint, ou la RAISON quand elle est refusée). */
    const optionCard = (title: string, onPick: () => void): { btn: HTMLButtonElement; hint: HTMLElement } => {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "lp-opt";
      const body = el("span", "lp-opt-body");
      const hint = el("em", "lp-opt-hint");
      body.append(el("span", "lp-opt-title", title), hint);
      btn.append(el("span", "lp-opt-dot"), body);
      btn.addEventListener("click", () => { if (!btn.disabled) onPick(); });
      return { btn, hint };
    };
    const supportCards = SUPPORT_IDS.map((id) => {
      const card = optionCard(t("dialog.support." + id), () => {
        LabelPrintPolicy.applySupport(kind, id, st);
        if (needQr()) ensureQrs(); else render();
      });
      supportOpts.appendChild(card.btn);
      return { id, ...card };
    });
    support.box.appendChild(supportOpts);

    // Gabarits d'étiquette plate — SOUS la carte « Étiquette plate » seulement (les autres
    // supports SONT un gabarit). Absents, pas grisés : ce n'est pas un refus, c'est une
    // question qui ne se pose pas.
    const LABEL_SIZES: LabelSizeId[] = ["s", "m", "l", "custom"];
    const sizeSeg = FormControls.segmented(
      LABEL_SIZES.map((s) => ({ value: s, label: t("dialog.size." + s) })),
      st.size,
      (v) => { st.size = v as LabelSizeId; render(); },
      { ariaLabel: t("dialog.sizeLabel") },
    );
    const sizeButtons = [...sizeSeg.querySelectorAll("button")] as HTMLButtonElement[];
    const sizeRow = labelled(t("dialog.sizeLabel"), sizeSeg);
    support.box.appendChild(sizeRow);

    // Cotes en mm — la LISTE vient du support (`availability.cotes`) : une cote qui ne
    // s'applique pas est absente, pas grisée (elle n'a pas de valeur à montrer).
    const mmRow = el("div", "lp-mm");
    const cwI = FormControls.number(st.customW, { min: 20, max: 210, step: 1 });
    const chI = FormControls.number(st.customH, { min: 12, max: 297, step: 1 });
    const cqI = FormControls.number(st.qr, { min: 12, max: 60, step: 1 });
    const cdI = FormControls.number(st.dia, { min: 3, max: 30, step: 0.5 });
    const clI = FormControls.number(st.len, { min: 10, max: 60, step: 1 });
    const coteFields: Record<LabelCoteId, HTMLElement> = {
      w: numField(t("dialog.widthMm"), cwI), h: numField(t("dialog.heightMm"), chI),
      qr: numField(t("dialog.qrMm"), cqI), dia: numField(t("dialog.diaMm"), cdI), len: numField(t("dialog.lenMm"), clI),
    };
    mmRow.append(coteFields.w, coteFields.h, coteFields.dia, coteFields.len, coteFields.qr);
    support.box.appendChild(mmRow);

    // Bascule A / B / A+B — ANATOMIE, pas axe fixe : elle est ABSENTE hors sujet à drapeau
    // (un équipement n'a pas de bouts), et seulement GRISÉE quand le contenu n'imprime aucun
    // texte d'extrémité à marquer (là, c'est un refus qui s'explique).
    const endsSeg = FormControls.segmented(
      [{ value: "a", label: t("dialog.endsA") }, { value: "b", label: t("dialog.endsB") }, { value: "ab", label: t("dialog.endsAb") }],
      st.endsMode,
      (v) => { st.endsMode = v as LabelEndsMode; render(); },
      { ariaLabel: t("dialog.ends") },
    );
    const endsButtons = [...endsSeg.querySelectorAll("button")] as HTMLButtonElement[];
    const endsRow = labelled(t("dialog.ends"), endsSeg);
    support.box.appendChild(endsRow);
    const supportWhy = why(); support.box.appendChild(supportWhy);

    /* ============================ ② CONTENU ============================ */
    const contentStage = stage("②", t("dialog.stageContent"));
    const CONTENT_IDS: LabelContentId[] = ["full", "qr", "strip", "id"];
    const contentOpts = el("div", "lp-opts");
    const contentCards = CONTENT_IDS.map((id) => {
      const card = optionCard(t("dialog.content." + id), () => {
        st.content = id;
        // Le couplage support ⇄ contenu est écrit UNE fois, dans la politique : choisir un
        // contenu de manchon EST choisir le manchon (et réciproquement).
        LabelPrintPolicy.applySupport(kind, LabelPrintPolicy.supportOf(st.size, id), st);
        if (needQr()) ensureQrs(); else render();
      });
      contentOpts.appendChild(card.btn);
      return { id, ...card };
    });
    contentStage.box.appendChild(contentOpts);
    const contentWhy = why(); contentStage.box.appendChild(contentWhy);

    /* =================== ③ INFORMATIONS ADDITIONNELLES =================== */
    const fieldsStage = stage("③", t("dialog.stageFields"));
    const fieldsCount = el("p", "lp-count");
    fieldsStage.box.appendChild(fieldsCount);
    const fieldsCol = el("div", "lp-fields");
    fieldsStage.box.appendChild(fieldsCol);
    /** Valeur affichée à DROITE d'une case (décision Q11.6) : la valeur quand il n'y a qu'un
        sujet ; « déclaré par n / N » sur une planche, où montrer la valeur d'un seul
        déclarant pour 150 étiquettes serait un mensonge (l'infobulle donne alors celle du
        PREMIER déclarant, à titre d'exemple). */
    const fieldValue = (id: string): { text: string; title: string } => {
      const declaring = subjects.filter((s) => (s.fields || []).some((f) => f.id === id));
      const first = declaring.length ? (declaring[0].fields || []).find((f) => f.id === id) : null;
      if (subjectCount === 1) return { text: first ? first.value : "", title: first ? first.value : "" };
      return {
        text: t("dialog.fieldDeclaredBy", { n: declaring.length, total: subjectCount }),
        title: first ? first.value : "",
      };
    };
    const valueSpan = (text: string, title: string): HTMLElement => {
      const span = el("span", "lp-field-v", text);
      if (title) span.title = title;
      return span;
    };
    // Rangée STRUCTURELLE « Identifiant » : toujours cochée, jamais décochable — c'est ce
    // que le QR encode et ce que l'étiquette existe pour dire.
    const idRow = FormControls.toggle(t("dialog.fieldId"), true, () => { /* toujours coché */ }, { disabled: true, block: true });
    // L'identifiant est déclaré par TOUS les sujets par construction (c'est leur nom) : sur
    // une planche on annonce donc « déclaré par N / N », et l'infobulle donne le premier.
    idRow.appendChild(valueSpan(
      subjectCount === 1 ? (subjects[0].name || "") : t("dialog.fieldDeclaredBy", { n: subjectCount, total: subjectCount }),
      subjects[0].name || "",
    ));
    fieldsCol.appendChild(idRow);
    // Bascule « Extrémités A / B » — structurelle elle aussi (anatomie des drapeaux).
    const endsTextToggle = FormControls.toggle(t("dialog.fieldEnds"), st.ends, (v) => { st.ends = v; render(); }, { block: true });
    fieldsCol.appendChild(endsTextToggle);
    const fieldToggles = offer.map((o) => {
      const toggle = FormControls.toggle(o.label, !!st.fields[o.id], (v) => { st.fields[o.id] = v; render(); }, { block: true });
      const value = fieldValue(o.id);
      toggle.appendChild(valueSpan(value.text, value.title));
      fieldsCol.appendChild(toggle);
      return { id: o.id, el: toggle };
    });
    const fieldsWhy = why(); fieldsStage.box.appendChild(fieldsWhy);

    /* ------------------------------- aperçu ------------------------------- */
    const meta = el("div", "lp-meta");
    const metaKind = el("span");
    const metaStat = el("span", "lp-stat");
    meta.append(metaKind, metaStat);
    const viewport = el("div", "lp-vp");
    const footStat = el("div", "lp-foot-stat");
    const riskBox = el("div", "lp-risk");
    riskBox.hidden = true;
    prev.append(meta, viewport, footStat, riskBox);

    /* ------------------------------ pied de modale ------------------------------ */
    const sheetBox = el("div", "lp-sheetnote");
    const exportBtn = document.createElement("button");
    exportBtn.type = "button"; exportBtn.className = "btn btn-ghost";
    exportBtn.innerHTML = `<span class="gi">${Icons.EXPORT}</span>${Html.escape(t("dialog.exportImages"))}`;
    const printBtn = document.createElement("button");
    printBtn.type = "button"; printBtn.className = "btn btn-primary";
    printBtn.innerHTML = `<span class="gi">${Icons.PRINT}</span>${Html.escape(t("dialog.print"))}`;

    /* --------------------------------- données QR --------------------------------- */
    const qrKey = (s: LabelSubject) => s.collection + "/" + s.id;
    const qrCache = new Map<string, string>();
    let qrLoading = false;
    let qrError: string | null = null;
    let exporting = false;
    const needQr = (): boolean => st.content !== "strip" && st.content !== "id";
    const uniqueSubjects = (): LabelSubject[] => subjects.filter((s, i) => subjects.findIndex((o) => qrKey(o) === qrKey(s)) === i);
    const ensureQrs = (): void => {
      const missing = uniqueSubjects().filter((s) => !qrCache.has(qrKey(s)));
      if (!missing.length) { render(); return; }
      qrLoading = true; qrError = null; render();
      Promise.all(missing.map((s) => host.fetchQrSvg(s.collection, s.id).then((svg) => { qrCache.set(qrKey(s), svg); })))
        .catch((e) => { qrError = (e && (e as Error).message) || String(e); })
        .then(() => { qrLoading = false; render(); });
    };
    /** Côté du QR en modules (quiet zone comprise) — LE nombre dont dépend la quantification.
        On prend le MAXIMUM du tirage : les identifiants n'ont pas tous la même longueur, donc
        pas forcément la même version de QR, et deux cotes différentes sur une même planche se
        verraient. Le max est le choix SÛR (plus de modules ⇒ cote quantifiée plus petite ⇒
        tout tient). Aucun QR chargé ⇒ 0, et la quantification est alors sautée. */
    const totalModules = (): number => {
      let max = 0;
      for (const svg of qrCache.values()) {
        const viewBox = LabelQrSvg.parseViewBox(svg);
        if (viewBox && viewBox[2] > max) max = viewBox[2];
      }
      return max;
    };

    /* ---------------------------------- rendu ---------------------------------- */
    const spec = (): LabelSpec => ({
      size: st.size, content: st.content, compact: st.compact,
      qr: LabelLayout.clampCustom("qr", st.qr),
      custom: { w: LabelLayout.clampCustom("w", st.customW), h: LabelLayout.clampCustom("h", st.customH) },
      dia: LabelLayout.clampCustom("dia", st.dia),
      len: LabelLayout.clampCustom("len", st.len),
      // Nom historique (« owner ») : y a-t-il une BANDE sous le carré en « QR seul » ?
      // T10 : c'est toute déclaration `qrOnly` cochée.
      hasOwner: subjects.some((s) => (s.fields || []).some((f) => f.qrOnly && st.fields[f.id])),
      dpi: st.dpi,
    });
    /** Cote de QR SERVIE — le point de passage unique (clamp des préréglages + quantification
        Q11.14). Sans lui, le SVG pouvait être servi à une cote que la boîte ne contenait pas. */
    const qrMmOf = (sp: LabelSpec, heightMm?: number): number => {
      const total = totalModules();
      return LabelLayout.renderQrMm(sp, heightMm, total > 0 ? { dpi: st.dpi, totalModules: total } : undefined);
    };
    const labelOf = (item: LabelPrintItem, sp: LabelSpec, dims?: [number, number]): string => {
      let svg = "";
      if (needQr()) {
        const raw = qrCache.get(qrKey(item.subject)) || "";
        if (raw) svg = LabelQrSvg.scaleToMm(raw, qrMmOf(sp, dims ? dims[1] : undefined));
      }
      return LabelHtml.label(item.subject, sp, { ends: st.ends, checked: st.fields, localEnd: item.localEnd }, svg, dims);
    };
    const items = (): LabelPrintItem[] => LabelPrintPolicy.expand(subjects, kind, st);
    const headRight = (count: number): string => t("sheetHead.count", { count, s: plural(count) }) + " · " + new Date().toLocaleDateString();

    /** Un CODE d'avertissement → sa phrase. À CONSÉQUENCE pour le registre « scan » (ce que
        ça coûtera sur le terrain), NEUTRE pour le registre « tirage » (ce qui va sortir). */
    const warnLabel = (code: LabelWarning, sp: LabelSpec, count: number): string => {
      const layout = LabelLayout.sheetLayout(sp, st.cols, count);
      const total = totalModules();
      switch (code) {
        case "qr-floor": return t("warn.qrFloor", { mm: LabelLayout.qrSizeOf(sp) });
        case "qr-exceeds-label": return t("warn.qrExceedsLabel", { qr: LabelLayout.qrSizeOf(sp) });
        case "columns-capped": return t("warn.columnsCapped", { w: +LabelLayout.cellDims(sp)[0].toFixed(1), cols: layout.cols, s: plural(layout.cols) });
        case "multi-page": return t("warn.multiPage", { count, pages: layout.pages });
        case "sleeve-tight": return t("warn.sleeveTight", { len: sp.len });
        case "module-too-small": return t("warn.moduleTooSmall", { mm: total > 0 ? +(qrMmOf(sp) / total).toFixed(2) : 0 });
      }
    };

    /** Raison traduite d'une option refusée — les CODES viennent tous de la politique. */
    const reasonText = (code: string): string => t("why." + code);

    let leadIsTirage: boolean | null = null;

    const render = (): void => {
      const sp = spec();
      const list = items();
      const labelCount = list.length;
      const paper = LabelPrintPolicy.paperOf(st.paper, labelCount);
      const currentSupport = LabelPrintPolicy.supportOf(st.size, st.content);
      // LE VERDICT — un seul appel, appliqué tel quel (aucune règle de disponibilité ici).
      const av = LabelPrintPolicy.availability(kind, currentSupport, st.content, offer);

      /* -- ordre des étages : Tirage en tête dès ≥ 2 étiquettes (le SEUL déplacement) --
         Réordonné seulement quand la condition BASCULE : déplacer un nœud à chaque rendu
         coûterait le focus du champ en cours de saisie. */
      const lead = labelCount >= 2;
      if (lead !== leadIsTirage) {
        leadIsTirage = lead;
        tirage.box.classList.toggle("lp-stage-lead", lead);
        const ordered = lead
          ? [tirage.box, support.box, contentStage.box, fieldsStage.box]
          : [support.box, contentStage.box, fieldsStage.box, tirage.box];
        for (const box of ordered) side.appendChild(box);
      }

      /* -- CONTEXTE -- */
      ctxWho.textContent = subjectCount > 1
        ? t("dialog.ctxMany", { n: subjectCount })
        : (subjects[0].name || "");
      ctxMeta.textContent = t("dialog.ctxMeta", {
        kind: t("kind." + kind), n: subjectCount, s: plural(subjectCount),
        labels: labelCount, ls: plural(labelCount),
      });
      memText.textContent = remembered ? t("dialog.memoryReused") : t("dialog.memoryDefaults");
      resetBtn.hidden = !remembered;

      /* -- ◈ TIRAGE -- */
      tirage.value.textContent = t("dialog.tirageValue", { labels: labelCount, ls: plural(labelCount) });
      if (document.activeElement !== occI) occI.value = String(st.occurrences);
      (paperSeg as unknown as { value: string }).value = paper;
      (dpiSeg as unknown as { value: string }).value = String(st.dpi);
      (densSeg as unknown as { value: string }).value = st.compact ? "compact" : "comfort";
      cutsToggle.disabled = paper !== "sheet";
      cutsToggle.title = paper === "sheet" ? "" : reasonText("roll-no-cuts");
      colsRow.hidden = paper !== "sheet";
      const maxCols = LabelLayout.maxColumns(sp);
      if (st.cols > maxCols) st.cols = maxCols;
      (colsSeg as unknown as { value: string }).value = String(st.cols);
      colsButtons.forEach((btn, index) => {
        const capped = index + 1 > maxCols;
        btn.disabled = capped;
        btn.title = capped ? t("why.cols-capped", { max: maxCols }) : "";
      });
      const layout = LabelLayout.sheetLayout(sp, st.cols, labelCount);
      setWhy(tirageWhy, paper === "sheet"
        ? t("dialog.whySheet", { per: layout.perPage, pages: layout.pages, s: plural(layout.pages), auto: st.paper === "auto" ? t("dialog.paperAuto") : "" })
        : t("dialog.whyRoll", { pages: labelCount, s: plural(labelCount), auto: st.paper === "auto" ? t("dialog.paperAuto") : "" }));

      /* -- ① SUPPORT -- */
      support.value.textContent = t("dialog.support." + currentSupport);
      for (const card of supportCards) {
        const reason = av.supports[card.id];
        card.btn.disabled = reason !== "ok";
        card.btn.setAttribute("aria-pressed", card.id === currentSupport ? "true" : "false");
        card.hint.textContent = reason === "ok" ? t("dialog.supportHint." + card.id) : reasonText(reason);
        card.btn.title = reason === "ok" ? "" : reasonText(reason);
      }
      sizeRow.hidden = currentSupport !== "label";
      (sizeSeg as unknown as { value: string }).value = st.size;
      sizeButtons.forEach((btn, index) => {
        const reason = av.sizes[LABEL_SIZES[index]];
        btn.disabled = reason !== "ok";
        btn.title = reason === "ok" ? "" : reasonText(reason);
      });
      const cotes = LabelPrintPolicy.cotesFor(currentSupport, st.content, st.size);
      (Object.keys(coteFields) as LabelCoteId[]).forEach((cote) => { coteFields[cote].hidden = !cotes.includes(cote); });
      mmRow.hidden = cotes.length === 0;
      if (document.activeElement !== cwI) cwI.value = String(st.customW);
      if (document.activeElement !== chI) chI.value = String(st.customH);
      if (document.activeElement !== cqI) cqI.value = String(st.qr);
      if (document.activeElement !== cdI) cdI.value = String(st.dia);
      if (document.activeElement !== clI) clI.value = String(st.len);
      // La bascule d'extrémités est ABSENTE hors drapeau (question sans objet), GRISÉE quand
      // le contenu n'a pas de texte d'extrémité à marquer (refus qui s'explique).
      endsRow.hidden = av.ends === "not-flag";
      (endsSeg as unknown as { value: string }).value = st.endsMode;
      endsButtons.forEach((btn) => {
        btn.disabled = av.ends === "no-text";
        btn.title = av.ends === "no-text" ? reasonText("no-text") : "";
      });
      const sleeve = currentSupport === "sleeve";
      setWhy(supportWhy, sleeve
        ? t("dialog.sleeveHint", { dia: sp.dia, ov: +LabelLayout.sleeveGeometry(sp.dia, sp.len).overlap.toFixed(1), len: sp.len })
        : (LabelLayout.qrSizeOf(sp) >= LabelLayout.QR_FLOOR_MM ? t("dialog.qrOk", { mm: +qrMmOf(sp).toFixed(1) }) : t("dialog.qrLow", { mm: +qrMmOf(sp).toFixed(1) })));

      /* -- ② CONTENU -- */
      contentStage.value.textContent = t("dialog.content." + st.content);
      for (const card of contentCards) {
        const reason = av.contents[card.id];
        card.btn.disabled = reason !== "ok";
        card.btn.setAttribute("aria-pressed", card.id === st.content ? "true" : "false");
        card.hint.textContent = reason === "ok" ? t("dialog.contentHint." + card.id) : reasonText(reason);
        card.btn.title = reason === "ok" ? "" : reasonText(reason);
      }
      setWhy(contentWhy, t("dialog.whyContent"));

      /* -- ③ INFORMATIONS ADDITIONNELLES -- */
      const activeFields = fieldToggles.filter((f) => av.fields[f.id] === "ok" && st.fields[f.id]).length;
      fieldsStage.value.textContent = t("dialog.fieldsValue", { on: activeFields, total: offer.length });
      fieldsCount.textContent = t("dialog.fieldsCount", { n: offer.length, s: plural(offer.length) });
      // La rangée « Identifiant » ne disparaît JAMAIS (c'est ce que le QR encode et ce que
      // l'étiquette existe pour dire) ; sous un contenu sans texte, elle porte juste la raison.
      idRow.title = (st.content === "qr" || st.content === "id") ? reasonText("no-text") : "";
      endsTextToggle.hidden = av.ends === "not-flag";
      endsTextToggle.disabled = av.ends === "no-text";
      endsTextToggle.title = av.ends === "no-text" ? reasonText("no-text") : "";
      for (const f of fieldToggles) {
        const inert = av.fields[f.id] !== "ok";
        f.el.disabled = inert;
        f.el.title = inert ? reasonText("no-text") : "";
      }
      setWhy(fieldsWhy, t("dialog.whyFields"));

      /* -- AVERTISSEMENTS : deux registres (classification pure de la politique) -- */
      const warns = LabelLayout.warnings(sp, { count: labelCount, requestedCols: st.cols, longestIdLength: longestId, totalModules: totalModules() || undefined });
      const scan = warns.filter((c) => LabelPrintPolicy.warningRegister(c) === "scan");
      const sheetWarns = warns.filter((c) => LabelPrintPolicy.warningRegister(c) === "sheet");
      riskBox.hidden = scan.length === 0;
      riskBox.innerHTML = "";
      if (scan.length) {
        const head = el("h6", "lp-risk-h");
        head.innerHTML = `<span class="gi" aria-hidden="true">${Icons.WARNING}</span><span></span>`;   // SVG de confiance (ui/Icons)
        (head.querySelector("span:last-child") as HTMLElement).textContent = t("risk.title");
        riskBox.appendChild(head);
        for (const code of scan) riskBox.appendChild(el("p", undefined, warnLabel(code, sp, labelCount)));
      }
      sheetBox.textContent = sheetWarns.map((code) => warnLabel(code, sp, labelCount)).join(" · ");
      sheetBox.hidden = sheetWarns.length === 0;   // rien à dire ⇒ pas de blanc devant les actions du pied

      /* -- APERÇU -- */
      const [w, h] = LabelLayout.labelDims(sp);
      const busy = needQr() && (qrLoading || !!qrError);
      printBtn.disabled = busy;
      exportBtn.disabled = busy || exporting;
      if (needQr() && qrError) {
        viewport.innerHTML = `<div class="lp-msg err">${Html.escape(t("dialog.loadError", { msg: qrError }))}</div>`;
        metaKind.textContent = t("dialog.preview"); metaStat.textContent = ""; footStat.textContent = "";
        return;
      }
      if (needQr() && qrLoading) {
        viewport.innerHTML = `<div class="lp-msg">${Html.escape(t("dialog.loading"))}</div>`;
        metaKind.textContent = t("dialog.preview"); metaStat.textContent = ""; footStat.textContent = "";
        return;
      }
      metaStat.textContent = t("dialog.statDims", { w: +w.toFixed(1), h: +h.toFixed(1) });
      if (paper === "roll") {
        // ROULEAU : l'aperçu montre la PREMIÈRE étiquette à sa cote réelle ; le compte dit le reste.
        metaKind.textContent = t("dialog.previewRoll");
        footStat.textContent = t("dialog.statRoll", { pages: labelCount, s: plural(labelCount) });
        viewport.innerHTML = `<div class="label-render"><div class="lp-paper">${labelOf(list[0], sp)}</div></div>`;
      } else {
        metaKind.textContent = t("dialog.previewSheet");
        metaStat.textContent += " · " + t("dialog.statPerPage", { cols: layout.cols, per: layout.perPage });
        footStat.textContent = t("dialog.statSheet", { count: labelCount, pages: layout.pages, s: plural(layout.pages) });
        const cells = list.slice(0, layout.perPage).map((item) => labelOf(item, sp, [layout.cellW, layout.cellH]));
        const page = LabelHtml.sheetPage(cells, layout, { source: ctx.source, headRight: headRight(labelCount), cuts: st.cuts });
        viewport.innerHTML = `<div class="label-render lp-a4-hold"><div class="lp-a4-scale">${page}</div></div>`;
      }
    };

    /* -------------------------------- interactions -------------------------------- */
    const numInput = (input: HTMLInputElement, apply: (v: number) => void) => {
      input.oninput = () => { const v = parseFloat(input.value); if (Number.isFinite(v) && v > 0) { apply(v); render(); } };
    };
    numInput(cwI, (v) => { st.customW = v; });
    numInput(chI, (v) => { st.customH = v; });
    numInput(cqI, (v) => { st.qr = v; });
    numInput(cdI, (v) => { st.dia = v; });
    numInput(clI, (v) => { st.len = v; });
    // Occurrences : borné À LA SAISIE (la politique porte les bornes). Un champ VIDE
    // (l'utilisateur efface avant de retaper) n'écrase rien : on attend un nombre.
    occI.oninput = () => {
      const typed = parseInt(occI.value, 10);
      if (!Number.isFinite(typed)) return;
      const clamped = Math.max(LabelPrintPolicy.OCCURRENCES_MIN, Math.min(LabelPrintPolicy.OCCURRENCES_MAX, typed));
      st.occurrences = clamped;
      if (String(clamped) !== occI.value) occI.value = String(clamped);
      render();
    };
    // « Revenir aux défauts » : efface l'entrée de session du contexte, re-sanitize, re-rend.
    resetBtn.onclick = () => {
      LabelPrintDialog.session.delete(kind);
      const fresh = LabelPrintPolicy.defaults(kind);
      if (ctx.defaultEndsMode) fresh.endsMode = ctx.defaultEndsMode;
      Object.assign(st, fresh, { fields: {} });
      LabelPrintPolicy.sanitize(kind, offer, st);
      LabelPrintDialog.session.set(kind, st);
      remembered = false;
      // Les contrôles non reconstruits au rendu (cases) doivent suivre l'état remis à neuf.
      for (const f of fieldToggles) (f.el as unknown as { checked: boolean }).checked = !!st.fields[f.id];
      (endsTextToggle as unknown as { checked: boolean }).checked = st.ends;
      (cutsToggle as unknown as { checked: boolean }).checked = st.cuts;
      if (needQr()) ensureQrs(); else render();
    };

    /* --------------------------------- impression --------------------------------- */
    printBtn.onclick = () => {
      const sp = spec();
      const list = items();
      const paper = LabelPrintPolicy.paperOf(st.paper, list.length);
      let pageSize: string, pagesHtml = "";
      if (paper === "roll") {
        // ROULEAU : une page à la cote EXACTE de l'étiquette, PAR étiquette (Q11.12b) —
        // `printDocument` sépare déjà les `.unit` par un saut de page.
        const [w, h] = LabelLayout.labelDims(sp);
        pageSize = `${+w.toFixed(2)}mm ${+h.toFixed(2)}mm`;
        pagesHtml = list.map((item) => `<div class="unit">${labelOf(item, sp)}</div>`).join("");
      } else {
        pageSize = "A4";
        const layout = LabelLayout.sheetLayout(sp, st.cols, list.length);
        for (let p = 0; p < layout.pages; p++) {
          const pageItems = list.slice(p * layout.perPage, (p + 1) * layout.perPage);
          pagesHtml += LabelHtml.sheetPage(
            pageItems.map((item) => labelOf(item, sp, [layout.cellW, layout.cellH])),
            layout, { source: ctx.source, headRight: headRight(list.length), cuts: st.cuts },
          );
        }
      }
      LabelPrintDialog.printHtml(LabelHtml.printDocument({ title: t("dialog.title") + " — " + ctx.source, pageSize, pagesHtml, fontCss: host.fontCss }));
    };

    /* ------------------------------ export en images ------------------------------ */
    exportBtn.onclick = async () => {
      if (exporting) return;
      const sp = spec();
      const list = items();
      // Le besoin premier est UNE IMAGE PAR ÉTIQUETTE ; la planche entière est une option, et
      // elle n'a de sens que quand le tirage EST une planche. Une planche ⇒ on demande, sinon
      // on ne pose pas une question à réponse unique (`Dialog.choice`, primitive existante).
      let mode: "labels" | "sheets" = "labels";
      if (LabelPrintPolicy.paperOf(st.paper, list.length) === "sheet") {
        const layout = LabelLayout.sheetLayout(sp, st.cols, list.length);
        const picked = await Dialog.choice({
          title: t("dialog.exportImages"),
          message: t("export.chooseMessage"),
          choices: [
            { label: t("export.chooseLabels"), value: "labels", hint: t("export.chooseLabelsHint", { n: list.length, s: plural(list.length) }) },
            { label: t("export.chooseSheets"), value: "sheets", hint: t("export.chooseSheetsHint", { pages: layout.pages, s: plural(layout.pages) }) },
          ],
        });
        if (picked !== "labels" && picked !== "sheets") return;   // Échap/Annuler : rien ne part
        mode = picked;
      }
      exporting = true; render();
      LabelImageExport.run({
        items: list, spec: sp, dpi: st.dpi, source: ctx.source, cols: st.cols, cuts: st.cuts,
        css: (host.fontCss || "") + LabelHtml.CSS,
        headRight: headRight(list.length),
        choice: { ends: st.ends, checked: st.fields },
        fetchMatrix: (collection, id) => host.fetchQrMatrix(collection, id),
        needQr: needQr(),
        mode,
      }).then(() => { exporting = false; render(); }, () => { exporting = false; render(); });
    };

    host.openModal({
      title: t("dialog.title"),
      subtitle: Html.escape(ctx.source),
      body: root,
      footerActions: [sheetBox, exportBtn, printBtn],
      hideFooter: true,
      wide: true,
    });
    if (needQr()) ensureQrs(); else render();
  }

  /** Imprime un document HTML autonome via une iframe CACHÉE : `print()` au `load`
      (tout est inline, rien d'externe à attendre), iframe retirée après coup
      (`afterprint` + filet temporel — certains navigateurs ne l'émettent pas). */
  private static printHtml(docHtml: string): void {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    document.body.appendChild(frame);
    let removed = false;
    const cleanup = () => { if (!removed) { removed = true; frame.remove(); } };
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) { cleanup(); return; }
      try { win.addEventListener("afterprint", () => setTimeout(cleanup, 250)); } catch { /* best-effort */ }
      // Un tick pour laisser le moteur poser la mise en page @page avant l'aperçu d'impression.
      setTimeout(() => { try { win.focus(); win.print(); } catch { cleanup(); } }, 50);
      setTimeout(cleanup, 120000);   // filet : l'aperçu abandonné sans afterprint ne laisse pas d'iframe orpheline
    };
    frame.srcdoc = docHtml;
  }
}
