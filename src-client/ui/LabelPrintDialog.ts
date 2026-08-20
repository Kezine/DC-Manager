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
   (`LabelPrintContext` — un objet, les 2 extrémités d'un câble ou d'un
   faisceau, le contenu d'une baie). Il s'ouvre dans la PILE DE MODALES
   STANDARD (principe n°11 — par-dessus la fiche appelante, ← y revient).

   DÉCOUPE : la géométrie est PURE (`core/LabelLayout`), la MATRICE DE
   VISIBILITÉ contextuelle est PURE (`core/LabelPrintPolicy`), le rendu HTML est
   PUR et PARTAGÉ aperçu ⇄ imprimé (`core/LabelHtml`), le SVG de QR est
   retravaillé PUREMENT (`core/LabelQrSvg`). Ici ne vivent que l'orchestration
   DOM, l'état de session et l'iframe d'impression.

   🚨 AUCUNE RÈGLE DE VISIBILITÉ ÉCRITE ICI (retours terrain 2026-08-20 : « tous
   les contrôles dans tous les contextes »). `render()` demande UN verdict à
   `LabelPrintPolicy.visibility(kind, contenu, format, nombre)` et se contente de
   POSER `hidden` — et `sanitize` ramène, à l'ouverture, des réglages mémorisés
   devenus invalides sur les défauts du contexte. Corollaire CSS indissociable :
   la feuille de l'app porte `.label-print [hidden]{display:none!important}` —
   sans elle, `.btn`/`.label-print-mm-field` (règles d'AUTEUR, qui battent
   toujours le `[hidden]` de la feuille du navigateur) rendaient ces `hidden`
   parfaitement INERTES. C'était la cause première du retour terrain.

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
import { LabelPrintPolicy } from "../core/LabelPrintPolicy";
import type { LabelPrintKind } from "../core/LabelPrintPolicy";

/** Ce que la modale attend de l'application (câblé UNE fois par main.ts, MODE API seulement). */
export interface LabelPrintHost {
  openModal(opts: ModalOptions): void;
  /** SVG brut de la route `GET …/qr/:collection/:id?format=svg` (rejette si 4xx/5xx —
      le message serveur est actionnable : PUBLIC_BASE_URL absente → 503 explicite). */
  fetchQrSvg(collection: string, id: string): Promise<string>;
}

/** Contexte d'ouverture — ce qui change entre les points d'entrée. Le TYPE de sujet
    (`LabelPrintKind`, faisceaux compris) vit dans `core/LabelPrintPolicy`, avec la
    matrice de visibilité qu'il pilote — ré-exporté ici pour les points d'entrée. */
export type { LabelPrintKind };
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

  /** Défauts d'un contexte — DÉCIDÉS par la politique pure (`core/LabelPrintPolicy`,
      valeurs de la maquette `openPrint`) : le premier tirage d'un contexte part de
      là, les suivants reprennent le dernier tirage de la session. */
  private static defaultsFor(kind: LabelPrintKind): LabelPrintSettings {
    return {
      size: LabelPrintPolicy.defaultSizeFor(kind),
      content: "full",
      compact: true,
      qr: LabelPrintPolicy.defaultQrFor(kind),
      customW: 50, customH: 25, dia: 6, len: 25,
      fields: LabelPrintPolicy.defaultFieldsFor(kind),
      cols: LabelPrintPolicy.defaultColsFor(kind),
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
    // Réglages mémorisés RAMENÉS dans ce que le contexte offre (retombée sur défaut —
    // un format drapeau hérité n'a aucun sens sur un équipement, cf. LabelPrintPolicy).
    const st = LabelPrintPolicy.sanitize(ctx.kind, LabelPrintDialog.settingsFor(ctx.kind));
    const count = subjects.length;
    // Verdict d'OUVERTURE : sert aux traits qui ne dépendent QUE du sujet et ne bougeront donc
    // plus (libellé « Emplacement » ⇄ « Extrémités A / B »). Tout le reste est réévalué à chaque
    // rendu — c'est le même appel, avec l'état courant.
    const openVis = LabelPrintPolicy.visibility(ctx.kind, st.content, st.size, count);
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

    // -- Contenu : options OFFERTES par le contexte (matrice LabelPrintPolicy —
    //    les manchons n'existent que pour les câbles/faisceaux) --
    const contentLabels: Record<LabelContentId, string> = {
      full: t("dialog.contentFull"), qr: t("dialog.contentQr"),
      strip: t("dialog.contentStrip"), id: t("dialog.contentId"),
    };
    const contentSel = FormControls.select(
      LabelPrintPolicy.contentsFor(ctx.kind).map((c) => ({ value: c, label: contentLabels[c] })), st.content);
    fset(t("dialog.content")).appendChild(contentSel);

    // -- Format : préréglages OFFERTS par le contexte (drapeau = câbles/faisceaux
    //    seulement, « Baie » = baies seulement — cf. LabelPrintPolicy.sizesFor) --
    const sizeLabels: Record<LabelSizeId, string> = {
      s: t("dialog.sizeS"), m: t("dialog.sizeM"), l: t("dialog.sizeL"),
      rack: t("dialog.sizeRack"), cable: t("dialog.sizeCable"), custom: t("dialog.sizeCustom"),
    };
    const sizeBox = fset(t("dialog.format"));
    const sizeHead = sizeBox.querySelector(".label-print-h") as HTMLElement;
    const sizeSel = FormControls.select(
      LabelPrintPolicy.sizesFor(ctx.kind).map((s) => ({ value: s, label: sizeLabels[s] })), st.size);
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

    // -- Informations additionnelles : identifiant verrouillé + cases par champ (owner incluse —
    //    décision E). Les cases PRÉSENTES sont celles que le SUJET possède ; celles que le CONTENU
    //    courant annule sont masquées au rendu (verdict `fields`), jamais décidées ici. --
    const fieldsBox = fset(t("dialog.fields"));
    const fieldsCol = document.createElement("div"); fieldsCol.className = "label-print-checks"; fieldsBox.appendChild(fieldsCol);
    const idToggle = FormControls.toggle(t("dialog.fieldId"), true, () => { /* toujours coché */ }, { disabled: true, block: true });
    // « Emplacement » devient « Extrémités A / B » pour les sujets à DRAPEAU (câble, faisceau) :
    // le verdict le dit, le dialogue n'a pas à savoir quelles familles sont concernées.
    const locToggle = FormControls.toggle(openVis.locationAsEnds ? t("dialog.fieldEnds") : t("dialog.fieldLocation"), st.fields.location, (v) => { st.fields.location = v; render(); }, { block: true });
    const typeToggle = FormControls.toggle(t("dialog.fieldType"), st.fields.type, (v) => { st.fields.type = v; render(); }, { block: true });
    const snToggle = FormControls.toggle(t("dialog.fieldSerial"), st.fields.serial, (v) => { st.fields.serial = v; render(); }, { block: true });
    const ownerToggle = FormControls.toggle(t("dialog.fieldOwner"), st.fields.owner, (v) => { st.fields.owner = v; render(); }, { block: true });
    fieldsCol.append(idToggle, locToggle, typeToggle, snToggle, ownerToggle);

    // -- Planche : colonnes plafonnées + traits de coupe. La section est CONSTRUITE dans tous les
    //    cas et masquée par le verdict (`showSheetSection` — ≥ 2 étiquettes) : une seule règle,
    //    écrite dans la politique, plutôt qu'un `if` de construction qui la dupliquerait. --
    const sheetBox = fset(t("dialog.sheet"));
    const colsHolder = document.createElement("div");
    sheetBox.appendChild(colsHolder);
    const cutsToggle = FormControls.toggle(t("dialog.cuts"), st.cuts, (v) => { st.cuts = v; render(); }, { block: true });
    cutsToggle.style.marginTop = "8px";
    sheetBox.appendChild(cutsToggle);

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
        // Cote SERVIE au SVG = celle que la boîte peut RÉELLEMENT contenir (`renderQrMm` applique le
        // clamp de `rectQrGeometry` — correctif du QR rogné en format S). Le même chemin sert
        // l'aperçu et l'imprimé, l'unitaire et la planche (la CELLULE donne alors la hauteur).
        if (raw) svg = LabelQrSvg.scaleToMm(raw, LabelLayout.renderQrMm(sp, dims ? dims[1] : undefined));
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
      // LE VERDICT — un seul appel, appliqué tel quel (aucune règle de visibilité ici, cf. en-tête).
      const vis = LabelPrintPolicy.visibility(ctx.kind, sp.content, sp.size, count);
      sizeHead.textContent = vis.header === "sleeve" ? t("dialog.formatSleeve")
        : vis.header === "qrSize" ? t("dialog.formatQrSize") : t("dialog.format");
      sizeSel.hidden = !vis.showSizeSelect;
      mmRow.hidden = !vis.showMmRow;
      cwF.hidden = !vis.showWidthHeight;
      chF.hidden = !vis.showWidthHeight;
      cqF.hidden = !vis.showQrMm;
      cdF.hidden = !vis.showDiaLen;
      clF.hidden = !vis.showDiaLen;
      idToggle.hidden = !vis.showIdRow;
      locToggle.hidden = !vis.fields.location;
      typeToggle.hidden = !vis.fields.type;
      snToggle.hidden = !vis.fields.serial;
      ownerToggle.hidden = !vis.fields.owner;
      fieldsBox.hidden = !vis.showFieldsSection;
      sheetBox.hidden = !vis.showSheetSection;
      sizeHint.textContent = sleeve
        // Le demi-tour excédentaire EST le recouvrement (cf. LabelLayout.sleeveGeometry) : on
        // l'annonce en mm, c'est la seule cote que l'utilisateur ne lit pas dans « L × H ».
        ? t("dialog.sleeveHint", { dia: sp.dia, ov: +LabelLayout.sleeveGeometry(sp.dia, sp.len).overlap.toFixed(1), len: sp.len })
        : (LabelLayout.qrSizeOf(sp) >= LabelLayout.QR_FLOOR_MM ? t("dialog.qrOk", { mm: LabelLayout.qrSizeOf(sp) }) : t("dialog.qrLow", { mm: LabelLayout.qrSizeOf(sp) }));

      // Colonnes de planche : reconstruites à chaque rendu (le plafond dépend du gabarit).
      if (vis.showSheetSection) {
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
    sizeSel.onchange = () => { st.size = (sizeSel.value as LabelSizeId) || LabelPrintPolicy.defaultSizeFor(ctx.kind); render(); };
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
