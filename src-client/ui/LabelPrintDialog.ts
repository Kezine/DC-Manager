/* =============================================================================
   LABELPRINTDIALOG — LA modale d'impression des étiquettes QR (lot E du chantier
   étiquettes QR). Documentation : docs/qr-scan.md § « Étiquettes imprimables ».
   La maquette design-system/briefs/qr-etiquettes-imprimables-maquette.html FAIT
   FOI (panneau de réglages, aperçu, avertissements) — amendée par les décisions
   du cadrage E : le « propriétaire » est le champ `owner` des ÉQUIPEMENTS
   (lot E1), derrière une CASE du bloc « Lisible humain » (décochée par défaut,
   mémorisée en session) ; sur une planche chaque étiquette porte le `owner` de
   SON enregistrement.

   UN SEUL écran de sortie : ce dialogue. Ce qui change est ce qu'il REÇOIT
   (`LabelPrintContext` — un objet, les 2 extrémités d'un câble, le contenu
   d'une baie). Il s'ouvre dans la PILE DE MODALES STANDARD (principe n°11 —
   par-dessus la fiche appelante, ← y revient).

   DÉCOUPE : la géométrie est PURE (`core/LabelLayout`), le rendu HTML est PUR
   et PARTAGÉ aperçu ⇄ imprimé (`core/LabelHtml`), le SVG de QR est retravaillé
   PUREMENT (`core/LabelQrSvg`). Ici ne vivent que l'orchestration DOM, l'état
   de session et l'iframe d'impression.

   MODE LOCAL : l'impression d'étiquettes est MODE API SEULEMENT (génération
   serveur, décision § 2.1 du handoff). Patron « injection nulle » (cf.
   AccessState/HydrationState) : `setup()` n'est appelé par main.ts QU'EN mode
   API — partout ailleurs `available()` rend faux et TOUTES les entrées
   d'impression restent masquées, sans le moindre test de mode dispersé.

   RÉGLAGES MÉMORISÉS EN SESSION (jamais de Prefs persistées — décision du
   cadrage) : le dernier tirage d'un même CONTEXTE (équipement / baie / câble /
   spare) est repris tel quel à la prochaine ouverture, dans l'onglet courant.

   IMPRESSION : document print-CSS ISOLÉ dans une iframe cachée — noir sur
   blanc, aucun token de thème. Unitaire = `@page` à la taille EXACTE de
   l'étiquette (imprimantes à rouleau Brother/Dymo) ; ≥ 2 étiquettes = planche
   A4 (marge 8 mm, grille, traits de coupe 0,2 mm désactivables), pagination
   silencieuse au-delà d'une feuille (le compteur l'annonce). Les QR étant
   INLINE dans le document (SVG déjà en main), le `print()` n'attend que le
   `load` de l'iframe — aucune ressource externe à charger.
   ============================================================================= */

import type { ModalOptions } from "./Modal";
import { FormControls } from "./FormControls";
import { Icons } from "./Icons";
import { Html } from "../core/Html";
import { I18n } from "../i18n/I18n";
import { LabelLayout } from "../core/LabelLayout";
import type { LabelSpec, LabelSizeId, LabelContentId, LabelWarning } from "../core/LabelLayout";
import { LabelHtml } from "../core/LabelHtml";
import type { LabelSubject, LabelFields } from "../core/LabelHtml";
import { LabelQrSvg } from "../core/LabelQrSvg";

/** Ce que la modale attend de l'application (câblé UNE fois par main.ts, MODE API seulement). */
export interface LabelPrintHost {
  openModal(opts: ModalOptions): void;
  /** SVG brut de la route `GET …/qr/:collection/:id?format=svg` (rejette si 4xx/5xx —
      le message serveur est actionnable : PUBLIC_BASE_URL absente → 503 explicite). */
  fetchQrSvg(collection: string, id: string): Promise<string>;
}

/** Contexte d'ouverture — ce qui change entre les points d'entrée. */
export type LabelPrintKind = "equipment" | "rack" | "cable" | "spare";
export interface LabelPrintContext {
  kind: LabelPrintKind;
  /** Étiquettes à tirer (1 = unitaire, ≥ 2 = planche). Un câble « 2 extrémités » =
      DEUX FOIS le même sujet (deux drapeaux identiques, un par bout). */
  subjects: LabelSubject[];
  /** Libellé de la source — sous-titre de la modale + en-tête de planche. */
  source: string;
}

/** Réglages d'un tirage — mémorisés EN SESSION par contexte (cf. en-tête). */
interface LabelPrintSettings {
  size: LabelSizeId;
  content: LabelContentId;
  compact: boolean;
  qr: number;
  customW: number;
  customH: number;
  dia: number;
  len: number;
  fields: LabelFields;
  cols: number;
  cuts: boolean;
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

  /** Défauts d'un contexte (maquette `openPrint`) — le premier tirage d'un contexte
      part de là, les suivants reprennent le dernier tirage de la session. */
  private static defaultsFor(kind: LabelPrintKind): LabelPrintSettings {
    return {
      size: kind === "cable" ? "cable" : kind === "rack" ? "rack" : kind === "spare" ? "s" : "m",
      content: "full",
      compact: true,
      qr: kind === "cable" ? 18 : 20,
      customW: 50, customH: 25, dia: 6, len: 25,
      // Emplacement coché partout ; type d'office pour câble/baie (maquette) ; owner
      // DÉCOCHÉ par défaut (décision E — mémorisé en session comme le reste).
      fields: { location: true, type: kind === "cable" || kind === "rack", serial: false, owner: false },
      cols: kind === "cable" ? 3 : 4,
      cuts: true,
    };
  }

  private static settingsFor(kind: LabelPrintKind): LabelPrintSettings {
    let settings = LabelPrintDialog.session.get(kind);
    if (!settings) { settings = LabelPrintDialog.defaultsFor(kind); LabelPrintDialog.session.set(kind, settings); }
    return settings;
  }

  /** Ouvre la modale d'impression. No-op si l'impression n'est pas disponible
      (les entrées sont masquées en amont — ceci n'est qu'une ceinture). */
  static open(ctx: LabelPrintContext): void {
    const host = LabelPrintDialog.host;
    const subjects = (ctx.subjects || []).filter(Boolean);
    if (!host || !subjects.length) return;
    const st = LabelPrintDialog.settingsFor(ctx.kind);
    const isCable = ctx.kind === "cable";
    const count = subjects.length;
    const longestId = subjects.reduce((max, s) => Math.max(max, (s.name || "").length), 0);
    const t = (key: string, vars?: Record<string, unknown>) => I18n.t("labels." + key, vars);

    /* ------------------------------- construction ------------------------------- */
    const root = document.createElement("div");
    root.className = "label-print";
    // CSS des étiquettes injectée UNE fois (scopée .label-render) : l'aperçu rend le
    // MÊME HTML que l'imprimé — fidélité par construction (cf. core/LabelHtml).
    const style = document.createElement("style");
    style.textContent = LabelHtml.CSS;
    root.appendChild(style);

    const side = document.createElement("div"); side.className = "label-print-side";
    const prev = document.createElement("div"); prev.className = "label-print-preview";
    root.append(side, prev);
    const fset = (title: string): HTMLElement => {
      const box = document.createElement("div"); box.className = "label-print-fset";
      const h = document.createElement("div"); h.className = "label-print-h"; h.textContent = title;
      box.appendChild(h); side.appendChild(box);
      return box;
    };

    // -- Contenu : QR + texte / QR seul (+ manchons pour les câbles) --
    const contentOpts = [
      { value: "full", label: t("dialog.contentFull") },
      { value: "qr", label: t("dialog.contentQr") },
      ...(isCable ? [
        { value: "strip", label: t("dialog.contentStrip") },
        { value: "id", label: t("dialog.contentId") },
      ] : []),
    ];
    if (!isCable && (st.content === "strip" || st.content === "id")) st.content = "full";   // garde : réglage hérité d'un autre onglet de session
    const contentSel = FormControls.select(contentOpts, st.content);
    fset(t("dialog.content")).appendChild(contentSel);

    // -- Format : préréglages (+ Personnalisé mm) ; les câbles n'ont que drapeau/personnalisé --
    const sizeOpts = isCable
      ? [{ value: "cable", label: t("dialog.sizeCable") }, { value: "custom", label: t("dialog.sizeCustom") }]
      : [
          { value: "s", label: t("dialog.sizeS") }, { value: "m", label: t("dialog.sizeM") },
          { value: "l", label: t("dialog.sizeL") }, { value: "rack", label: t("dialog.sizeRack") },
          { value: "custom", label: t("dialog.sizeCustom") },
        ];
    if (isCable && st.size !== "cable" && st.size !== "custom") st.size = "cable";
    if (!isCable && st.size === "cable") st.size = "m";
    const sizeBox = fset(t("dialog.format"));
    const sizeHead = sizeBox.querySelector(".label-print-h") as HTMLElement;
    const sizeSel = FormControls.select(sizeOpts, st.size);
    sizeBox.appendChild(sizeSel);
    // Rangée des cotes en mm (personnalisé / taille de QR / manchon) — visibilité par mode.
    const mmRow = document.createElement("div"); mmRow.className = "label-print-mm";
    const mmField = (label: string, input: HTMLInputElement): HTMLElement => {
      const wrap = document.createElement("label"); wrap.className = "label-print-mm-field";
      const span = document.createElement("span"); span.textContent = label;
      wrap.append(span, input);
      return wrap;
    };
    const cwI = FormControls.number(st.customW, { min: 20, max: 210, step: 1 });
    const chI = FormControls.number(st.customH, { min: 12, max: 297, step: 1 });
    const cqI = FormControls.number(st.qr, { min: 12, max: 60, step: 1 });
    const cdI = FormControls.number(st.dia, { min: 3, max: 30, step: 0.5 });
    const clI = FormControls.number(st.len, { min: 10, max: 60, step: 1 });
    const cwF = mmField(t("dialog.widthMm"), cwI), chF = mmField(t("dialog.heightMm"), chI);
    const cqF = mmField(t("dialog.qrMm"), cqI), cdF = mmField(t("dialog.diaMm"), cdI), clF = mmField(t("dialog.lenMm"), clI);
    mmRow.append(cwF, chF, cdF, clF, cqF);
    sizeBox.appendChild(mmRow);
    const sizeHint = document.createElement("div"); sizeHint.className = "form-hint"; sizeBox.appendChild(sizeHint);

    // -- Densité : compact (défaut) / confort --
    const densSeg = FormControls.segmented(
      [{ value: "compact", label: t("dialog.densityCompact") }, { value: "comfort", label: t("dialog.densityComfort") }],
      st.compact ? "compact" : "comfort",
      (v) => { st.compact = v === "compact"; render(); },
      { ariaLabel: t("dialog.density") },
    );
    fset(t("dialog.density")).appendChild(densSeg);

    // -- Lisible humain : identifiant verrouillé + cases par champ (owner incluse — décision E) --
    const fieldsBox = fset(t("dialog.fields"));
    const fieldsCol = document.createElement("div"); fieldsCol.className = "label-print-checks"; fieldsBox.appendChild(fieldsCol);
    const idToggle = FormControls.toggle(t("dialog.fieldId"), true, () => { /* toujours coché */ }, { disabled: true, block: true });
    const locToggle = FormControls.toggle(isCable ? t("dialog.fieldEnds") : t("dialog.fieldLocation"), st.fields.location, (v) => { st.fields.location = v; render(); }, { block: true });
    const typeToggle = FormControls.toggle(t("dialog.fieldType"), st.fields.type, (v) => { st.fields.type = v; render(); }, { block: true });
    const snToggle = FormControls.toggle(t("dialog.fieldSerial"), st.fields.serial, (v) => { st.fields.serial = v; render(); }, { block: true });
    const ownerToggle = FormControls.toggle(t("dialog.fieldOwner"), st.fields.owner, (v) => { st.fields.owner = v; render(); }, { block: true });
    fieldsCol.append(idToggle, locToggle, typeToggle, snToggle, ownerToggle);

    // -- Planche : colonnes plafonnées + traits de coupe — seulement à partir de 2 étiquettes --
    const sheetBox = count >= 2 ? fset(t("dialog.sheet")) : null;
    const colsHolder = document.createElement("div");
    let cutsToggle: HTMLButtonElement | null = null;
    if (sheetBox) {
      sheetBox.appendChild(colsHolder);
      cutsToggle = FormControls.toggle(t("dialog.cuts"), st.cuts, (v) => { st.cuts = v; render(); }, { block: true });
      cutsToggle.style.marginTop = "8px";
      sheetBox.appendChild(cutsToggle);
    }

    // -- Avertissements (codes de LabelLayout traduits ici) --
    const warnBox = document.createElement("div"); warnBox.className = "label-print-warn"; warnBox.hidden = true;
    side.appendChild(warnBox);

    // -- Aperçu --
    const meta = document.createElement("div"); meta.className = "label-print-meta";
    const metaKind = document.createElement("span");
    const metaStat = document.createElement("span"); metaStat.className = "label-print-stat";
    meta.append(metaKind, metaStat);
    const viewport = document.createElement("div"); viewport.className = "label-print-vp";
    const footStat = document.createElement("div"); footStat.className = "form-hint";
    prev.append(meta, viewport, footStat);

    /* --------------------------------- données QR --------------------------------- */
    const qrKey = (s: LabelSubject) => s.collection + "/" + s.id;
    const qrCache = new Map<string, string>();
    let qrLoading = false;
    let qrError: string | null = null;
    const needQr = (): boolean => st.content !== "strip" && st.content !== "id";
    const ensureQrs = (): void => {
      const missing = subjects.filter((s, i) => subjects.findIndex((o) => qrKey(o) === qrKey(s)) === i && !qrCache.has(qrKey(s)));
      if (!missing.length) { render(); return; }
      qrLoading = true; qrError = null; render();
      Promise.all(missing.map((s) => host.fetchQrSvg(s.collection, s.id).then((svg) => { qrCache.set(qrKey(s), svg); })))
        .catch((e) => { qrError = (e && (e as Error).message) || String(e); })
        .then(() => { qrLoading = false; render(); });
    };

    /* ---------------------------------- rendu ---------------------------------- */
    const spec = (): LabelSpec => ({
      size: st.size, content: st.content, compact: st.compact,
      qr: LabelLayout.clampCustom("qr", st.qr),
      custom: { w: LabelLayout.clampCustom("w", st.customW), h: LabelLayout.clampCustom("h", st.customH) },
      dia: LabelLayout.clampCustom("dia", st.dia),
      len: LabelLayout.clampCustom("len", st.len),
      hasOwner: st.fields.owner && subjects.some((s) => !!String(s.owner || "").trim()),
    });
    const labelOf = (s: LabelSubject, sp: LabelSpec, dims?: [number, number]): string => {
      let svg = "";
      if (needQr()) {
        const raw = qrCache.get(qrKey(s)) || "";
        if (raw) svg = LabelQrSvg.scaleToMm(raw, LabelLayout.qrSizeOf(sp));
      }
      return LabelHtml.label(s, sp, st.fields, svg, dims);
    };
    const plural = (n: number) => (n > 1 ? "s" : "");
    const headRight = (): string => t("sheetHead.count", { count, s: plural(count) }) + " · " + new Date().toLocaleDateString();

    const printBtn = document.createElement("button");
    printBtn.type = "button"; printBtn.className = "btn btn-primary";
    printBtn.innerHTML = `<span class="gi">${Icons.PRINT}</span>${Html.escape(t("dialog.print"))}`;

    const warnLabel = (code: LabelWarning, sp: LabelSpec): string => {
      const layout = LabelLayout.sheetLayout(sp, st.cols, count);
      switch (code) {
        case "qr-floor": return t("warn.qrFloor", { mm: LabelLayout.qrSizeOf(sp) });
        case "qr-exceeds-label": return t("warn.qrExceedsLabel", { qr: LabelLayout.qrSizeOf(sp) });
        case "columns-capped": return t("warn.columnsCapped", { w: +LabelLayout.cellDims(sp)[0].toFixed(1), cols: layout.cols, s: plural(layout.cols) });
        case "multi-page": return t("warn.multiPage", { count, pages: layout.pages });
        case "sleeve-tight": return t("warn.sleeveTight", { len: sp.len });
      }
    };

    const render = (): void => {
      const sp = spec();
      const sleeve = sp.content === "strip" || sp.content === "id";
      const qrOnly = sp.content === "qr";
      // Visibilité des contrôles (règles de la maquette) : le format s'efface derrière
      // la seule cote utile en QR seul / manchon ; les cotes libres suivent le mode.
      sizeHead.textContent = sleeve ? t("dialog.formatSleeve") : qrOnly ? t("dialog.formatQrSize") : t("dialog.format");
      sizeSel.hidden = qrOnly || sleeve;
      const qrDriven = qrOnly || sp.size === "cable";
      mmRow.hidden = !(qrDriven || sp.size === "custom" || sleeve);
      cwF.hidden = qrDriven || sleeve;
      chF.hidden = qrDriven || sleeve;
      cqF.hidden = sleeve;
      cdF.hidden = !sleeve;
      clF.hidden = !sleeve;
      // Lisible humain : tout masqué en « identifiant seul » ; en QR seul ne survit que
      // le propriétaire (bande sous le carré) ; le n° de série n'existe pas sur un câble.
      idToggle.hidden = qrOnly || sp.content === "id";
      locToggle.hidden = qrOnly || sp.content === "id";
      typeToggle.hidden = qrOnly || sp.content === "id";
      snToggle.hidden = isCable || qrOnly || sp.content === "id";
      ownerToggle.hidden = sp.content === "id";
      sizeHint.textContent = sleeve
        ? t("dialog.sleeveHint", { dia: sp.dia, len: sp.len })
        : (LabelLayout.qrSizeOf(sp) >= LabelLayout.QR_FLOOR_MM ? t("dialog.qrOk", { mm: LabelLayout.qrSizeOf(sp) }) : t("dialog.qrLow", { mm: LabelLayout.qrSizeOf(sp) }));

      // Colonnes de planche : reconstruites à chaque rendu (le plafond dépend du gabarit).
      if (sheetBox) {
        const maxCols = LabelLayout.maxColumns(sp);
        const effective = Math.min(st.cols, maxCols);
        colsHolder.innerHTML = "";
        colsHolder.appendChild(FormControls.segmented(
          [2, 3, 4].map((n) => ({ value: String(n), label: t("dialog.cols", { n }), disabled: n > maxCols })),
          String(effective),
          (v) => { st.cols = parseInt(v, 10) || 4; render(); },
          { ariaLabel: t("dialog.sheet") },
        ));
      }

      // Avertissements (codes purs → libellés).
      const warns = LabelLayout.warnings(sp, { count, requestedCols: st.cols, longestIdLength: longestId });
      warnBox.hidden = warns.length === 0;
      warnBox.textContent = warns.map((code) => warnLabel(code, sp)).join(" ");

      // Aperçu.
      const [w, h] = LabelLayout.labelDims(sp);
      if (needQr() && qrError) {
        viewport.innerHTML = `<div class="label-print-msg err">${Html.escape(t("dialog.loadError", { msg: qrError }))}</div>`;
        printBtn.disabled = true;
        metaKind.textContent = t("dialog.preview"); metaStat.textContent = ""; footStat.textContent = "";
        return;
      }
      if (needQr() && qrLoading) {
        viewport.innerHTML = `<div class="label-print-msg">${Html.escape(t("dialog.loading"))}</div>`;
        printBtn.disabled = true;
        metaKind.textContent = t("dialog.preview"); metaStat.textContent = ""; footStat.textContent = "";
        return;
      }
      printBtn.disabled = false;
      if (count < 2) {
        metaKind.textContent = t("dialog.previewUnit");
        metaStat.textContent = t("dialog.statDims", { w: +w.toFixed(1), h: +h.toFixed(1) });
        footStat.textContent = t("dialog.statUnit");
        viewport.innerHTML = `<div class="label-render"><div class="label-print-paper">${labelOf(subjects[0], sp)}</div></div>`;
      } else {
        const layout = LabelLayout.sheetLayout(sp, st.cols, count);
        metaKind.textContent = t("dialog.previewSheet");
        metaStat.textContent = t("dialog.statDims", { w: +w.toFixed(1), h: +h.toFixed(1) }) + " · " + t("dialog.statPerPage", { cols: layout.cols, per: layout.perPage });
        footStat.textContent = t("dialog.statSheet", { count, pages: layout.pages, s: plural(layout.pages) });
        const cells = subjects.slice(0, layout.perPage).map((s) => labelOf(s, sp, [layout.cellW, layout.cellH]));
        const page = LabelHtml.sheetPage(cells, layout, { source: ctx.source, headRight: headRight(), cuts: st.cuts });
        viewport.innerHTML = `<div class="label-render label-print-a4-hold"><div class="label-print-a4-scale">${page}</div></div>`;
      }
    };

    /* -------------------------------- interactions -------------------------------- */
    contentSel.onchange = () => {
      st.content = (contentSel.value as LabelContentId) || "full";
      if (needQr()) ensureQrs(); else render();
    };
    sizeSel.onchange = () => { st.size = (sizeSel.value as LabelSizeId) || (isCable ? "cable" : "m"); render(); };
    const numInput = (input: HTMLInputElement, apply: (v: number) => void) => {
      input.oninput = () => { const v = parseFloat(input.value); if (Number.isFinite(v) && v > 0) { apply(v); render(); } };
    };
    numInput(cwI, (v) => { st.customW = v; });
    numInput(chI, (v) => { st.customH = v; });
    numInput(cqI, (v) => { st.qr = v; });
    numInput(cdI, (v) => { st.dia = v; });
    numInput(clI, (v) => { st.len = v; });

    /* --------------------------------- impression --------------------------------- */
    printBtn.onclick = () => {
      const sp = spec();
      let pageSize: string, pagesHtml = "";
      if (count < 2) {
        const [w, h] = LabelLayout.labelDims(sp);
        pageSize = `${+w.toFixed(2)}mm ${+h.toFixed(2)}mm`;
        pagesHtml = `<div class="unit">${labelOf(subjects[0], sp)}</div>`;
      } else {
        pageSize = "A4";
        const layout = LabelLayout.sheetLayout(sp, st.cols, count);
        for (let p = 0; p < layout.pages; p++) {
          const pageSubjects = subjects.slice(p * layout.perPage, (p + 1) * layout.perPage);
          pagesHtml += LabelHtml.sheetPage(
            pageSubjects.map((s) => labelOf(s, sp, [layout.cellW, layout.cellH])),
            layout, { source: ctx.source, headRight: headRight(), cuts: st.cuts },
          );
        }
      }
      LabelPrintDialog.printHtml(LabelHtml.printDocument({ title: t("dialog.title") + " — " + ctx.source, pageSize, pagesHtml }));
    };

    host.openModal({
      title: t("dialog.title"),
      subtitle: Html.escape(ctx.source),
      body: root,
      footerActions: [printBtn],
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
