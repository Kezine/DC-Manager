/* ============================================================================
   LABELHTML — rendu HTML PUR des étiquettes imprimables (lot E du chantier
   étiquettes QR). Documentation : docs/qr-scan.md § « Étiquettes imprimables ».
   La maquette design-system/briefs/qr-etiquettes-imprimables-maquette.html FAIT
   FOI : structure (`.lab`, panneaux de drapeau, cellules de manchon, planche
   `.a4`) et registres typographiques portés d'elle.

   POURQUOI UN MODULE PUR (chaînes, pas de DOM) : le MÊME rendu sert DEUX
   surfaces — l'APERÇU de la modale (ui/LabelPrintDialog, mis à l'échelle) et le
   DOCUMENT D'IMPRESSION (iframe isolée, print-CSS embarquée). Écrire le label
   deux fois, c'est le voir diverger ; ici l'aperçu est fidèle PAR CONSTRUCTION.
   Corollaire : testable sous Node (Tests/modules/test-labels.js).

   NOIR SUR BLANC, TOUJOURS : l'imprimé ignore le thème de l'app — aucun token
   `var(--…)` du thème ici, uniquement des couleurs littérales. Le CSS est SCOPÉ
   sous `.label-render` pour cohabiter avec la feuille de l'app dans l'aperçu
   sans fuiter (l'imprimé, lui, n'a que ce CSS).

   Les QR arrivent DÉJÀ retravaillés (`core/LabelQrSvg.scaleToMm` — quiet zone
   garantie, cote en mm) : ce module les INLINE tels quels, il ne les touche pas.
   ============================================================================ */

import { Html } from "./Html";
import { LabelLayout } from "./LabelLayout";
import type { LabelSpec } from "./LabelLayout";

/** Matière d'UNE étiquette — préparée par `core/LabelSubjects` depuis le store.
    Champs absents/vides ⇒ la ligne correspondante n'est PAS rendue (décision
    « owner vide → ligne absente », généralisée à tout le lisible humain). */
export interface LabelSubject {
  collection: string;
  id: string;
  /** Identifiant imprimé (nom / désignation) — seul champ TOUJOURS rendu. */
  name: string;
  /** Emplacement (« B12 · U18-U19 », « Salle 2 »…). */
  location?: string;
  /** Type / famille lisible (« Serveur · Dell R650 », « Cat 6a · 3 m »…). */
  typeLabel?: string;
  serial?: string;
  /** Société propriétaire — champ `owner` de l'ENREGISTREMENT (lot E1), jamais une saisie d'impression. */
  owner?: string;
  /** Câble : extrémités A / B (drapeau, manchon « repère complet »). */
  endA?: string;
  endB?: string;
}

/** Cases « Lisible humain » de la modale (l'identifiant, lui, est toujours coché). */
export interface LabelFields {
  location: boolean;
  type: boolean;
  serial: boolean;
  owner: boolean;
}

export class LabelHtml {
  /** CSS des étiquettes — UNE source pour l'aperçu ET l'imprimé (cf. en-tête).
      Porté de la maquette, scopé `.label-render`, couleurs littérales seulement. */
  static readonly CSS = `
.label-render{--lp-mono:ui-monospace,"SF Mono","Menlo","Consolas","Cascadia Mono","Roboto Mono",monospace;--lp-sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#000}
.label-render *{box-sizing:border-box}
.label-render .lab{background:#fff;color:#000;display:flex;align-items:center;gap:2mm;padding:1.5mm;overflow:hidden;font-family:var(--lp-sans)}
.label-render .lab *{color:#000}
.label-render .lab svg{flex:none;display:block}
.label-render .lab .txt{min-width:0;display:flex;flex-direction:column;gap:.6mm}
.label-render .lab .l-id{font-family:var(--lp-mono);font-weight:700;line-height:1.08;letter-spacing:-.02em;overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.label-render .lab .l-loc{font-family:var(--lp-mono);line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.label-render .lab .l-meta{line-height:1.15;color:#333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.label-render .lab .l-sn{font-family:var(--lp-mono);color:#444;line-height:1.1}
.label-render .lab .l-own{font-family:var(--lp-sans);text-transform:uppercase;letter-spacing:.07em;color:#222;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}
.label-render .lab .rule{height:.35mm;background:#000;width:100%;margin:.8mm 0}
.label-render .lab.compact{padding:.7mm;gap:1.4mm}
.label-render .lab.s{gap:2mm}
.label-render .lab.s .l-id{font-size:8pt}.label-render .lab.s .l-loc{font-size:6.5pt}.label-render .lab.s .l-own{font-size:5pt}
.label-render .lab.m{gap:2mm}
.label-render .lab.m .l-id{font-size:8.5pt}.label-render .lab.m .l-loc{font-size:7pt}.label-render .lab.m .l-meta{font-size:6pt}.label-render .lab.m .l-sn{font-size:5.5pt}.label-render .lab.m .l-own{font-size:5.5pt}
.label-render .lab.l{gap:3mm;padding:3mm}
.label-render .lab.l .l-id{font-size:12pt}.label-render .lab.l .l-loc{font-size:9pt}.label-render .lab.l .l-meta{font-size:7.5pt}.label-render .lab.l .l-sn{font-size:7pt}.label-render .lab.l .l-own{font-size:7pt}
.label-render .lab.rack{gap:5mm;padding:4mm;align-items:center}
.label-render .lab.rack .l-id{font-size:26pt;letter-spacing:-.03em}
.label-render .lab.rack .l-loc{font-size:12pt;white-space:normal}
.label-render .lab.rack .l-meta{font-size:9pt}.label-render .lab.rack .l-sn{font-size:8pt}.label-render .lab.rack .l-own{font-size:9pt}
.label-render .lab.l.compact,.label-render .lab.rack.compact{padding:1.5mm}
.label-render .lab.qronly{justify-content:center;flex-direction:column}
.label-render .lab.qronly .txt{align-items:center;width:100%}
.label-render .lab.qronly .l-own{text-align:center}
.label-render .lab.cable{padding:0;gap:0;align-items:stretch}
.label-render .lab.cable .pan{flex:none;display:flex;align-items:center;justify-content:center;gap:1.2mm;overflow:hidden}
.label-render .lab.cable .pan.b{justify-content:flex-start}
.label-render .lab.cable .wz{flex:none;border-left:.2mm dashed #999;border-right:.2mm dashed #999;background:repeating-linear-gradient(45deg,#fff 0 1mm,#e9e9e9 1mm 2mm)}
.label-render .lab.cable .txt{gap:.4mm}
.label-render .lab.cable .l-id{font-size:7pt;line-height:1.1}
.label-render .lab.cable .l-loc,.label-render .lab.cable .l-meta,.label-render .lab.cable .l-own{font-size:5pt;white-space:normal;overflow-wrap:anywhere;line-height:1.2}
.label-render .lab.cable .l-loc b{font-family:var(--lp-mono);font-weight:700;color:#000}
.label-render .lab.cable.strip{align-items:stretch;gap:0;padding:0}
.label-render .lab.cable.strip .cell2{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1mm 0;overflow:hidden;border-right:.2mm dashed #ccc;writing-mode:vertical-rl}
.label-render .lab.cable.strip .cell2 .l-id{font-size:8pt;letter-spacing:0;display:block;white-space:nowrap;text-overflow:ellipsis;max-width:100%}
.label-render .lab.cable.strip .cell2 .l-loc,.label-render .lab.cable.strip .cell2 .l-own{font-size:5pt;white-space:normal;overflow-wrap:anywhere;text-align:start;max-height:100%}
.label-render .lab.cable.strip .ov{flex:none;background:repeating-linear-gradient(45deg,#fff 0 1mm,#e9e9e9 1mm 2mm);border-left:.2mm dashed #999}
.label-render .a4{width:210mm;height:297mm;background:#fff;padding:8mm;display:grid;gap:0;align-content:start}
.label-render .a4 .cell{border:.2mm dashed #bbb;display:flex;align-items:center;justify-content:center;overflow:hidden}
.label-render .a4 .cell.nocut{border:0}
.label-render .a4-head{display:flex;justify-content:space-between;font-family:var(--lp-mono);font-size:6pt;color:#666;grid-column:1/-1;padding-bottom:2mm}
.label-render .a4-head span{color:#666}
.label-render .unit{background:#fff;display:flex;align-items:flex-start;justify-content:flex-start}
`;

  /* -------------------------------- une étiquette -------------------------------- */

  /** Une étiquette — HTML autonome (styles inline pour les COTES, classes pour la
      typographie). `qrSvg` = SVG déjà mis à l'échelle (`LabelQrSvg.scaleToMm`,
      cote = `LabelLayout.qrSizeOf(spec)` mm) — vide pour les manchons.
      `dims` (optionnel) force les cotes : sur une PLANCHE, l'étiquette prend la
      taille de sa CELLULE (cf. LabelLayout, « cellule ≠ étiquette »). */
  static label(subject: LabelSubject, spec: LabelSpec, fields: LabelFields, qrSvg: string, dims?: [number, number]): string {
    const esc = Html.escape;
    const cp = spec.compact;
    const own = fields.owner ? String(subject.owner || "").trim() : "";
    const mm = (v: number) => +v.toFixed(2);

    if (spec.size === "cable") {
      if (spec.content === "strip" || spec.content === "id") {
        // MANCHON sans QR : cellules d'un tour répétées (2 = repère complet en double,
        // 6 = identifiant seul lisible sous tous les angles) + zone de recouvrement.
        const g = LabelLayout.sleeveGeometry(spec.dia, spec.len, cp);
        const idOnly = spec.content === "id";
        const extra = idOnly ? "" :
          (fields.location && (subject.endA || subject.endB) ? `<div class="l-loc"><b>A</b> ${esc(subject.endA || "")}</div><div class="l-loc"><b>B</b> ${esc(subject.endB || "")}</div>` : "")
          + (fields.type && subject.typeLabel ? `<div class="l-loc">${esc(subject.typeLabel)}</div>` : "")
          + (own ? `<div class="l-own">${esc(own)}</div>` : "");
        const cell = `<div class="cell2"><div class="l-id">${esc(subject.name)}</div>${extra}</div>`;
        return `<div class="lab cable strip${cp ? " compact" : ""}" style="width:${mm(g.w)}mm;height:${mm(g.h)}mm">${cell.repeat(idOnly ? 6 : 2)}<div class="ov" style="width:${g.overlap}mm"></div></div>`;
      }
      // DRAPEAU : QR à gauche, texte (ou second QR — « scannable des deux faces ») à
      // droite, zone d'enroulement hachurée entre les deux. Géométrie dérivée du QR.
      const g = LabelLayout.flagGeometry(LabelLayout.qrSizeOf(spec), cp);
      let t = `<div class="l-id">${esc(subject.name)}</div>`;
      if (fields.location && (subject.endA || subject.endB)) t += `<div class="l-loc"><b>A</b> ${esc(subject.endA || "")}</div><div class="l-loc"><b>B</b> ${esc(subject.endB || "")}</div>`;
      if (fields.type && subject.typeLabel) t += `<div class="l-meta">${esc(subject.typeLabel)}</div>`;
      if (own) t += `<div class="l-own">${esc(own)}</div>`;
      const panB = spec.content === "qr" ? qrSvg : `<div class="txt">${t}</div>`;
      return `<div class="lab cable${cp ? " compact" : ""}" style="width:${mm(g.w)}mm;height:${mm(g.h)}mm">`
        + `<div class="pan" style="width:${g.pan}mm;padding:${g.pad}mm">${qrSvg}</div>`
        + `<div class="wz" style="width:${g.wz}mm"></div>`
        + `<div class="pan b" style="width:${g.pan}mm;padding:${g.pad}mm">${panB}</div></div>`;
    }

    const [w, h] = dims || LabelLayout.labelDims(spec);
    const cls = spec.size === "custom" ? LabelLayout.fontClassForHeight(h) : spec.size;

    if (spec.content === "qr") {
      // QR SEUL : carré (QR + marges), éventuelle bande propriétaire sous le carré.
      const g = LabelLayout.qrOnlyGeometry(spec.qr, cp, !!own);
      return `<div class="lab ${cls} qronly${cp ? " compact" : ""}" style="width:${mm(g.side)}mm;height:${mm(g.side)}mm;padding:${g.pad}mm;gap:${g.gap}mm">${qrSvg}${own ? `<div class="txt"><div class="l-own">${esc(own)}</div></div>` : ""}</div>`;
    }

    // QR + TEXTE (gabarits S/M/L/Baie/personnalisé) : QR TOUJOURS à gauche (la main
    // sait où viser sans lire), colonne de texte à droite — anatomie de la maquette.
    const big = cls === "l" || cls === "rack";
    let t = `<div class="l-id">${esc(subject.name)}</div>`;
    if (fields.location && subject.location) t += `<div class="l-loc">${esc(subject.location)}</div>`;
    if (big && ((fields.type && subject.typeLabel) || (fields.serial && subject.serial) || own)) t += `<div class="rule"></div>`;
    if (fields.type && subject.typeLabel && cls !== "s") t += `<div class="l-meta">${esc(subject.typeLabel)}</div>`;
    if (fields.serial && subject.serial && cls !== "s") t += `<div class="l-sn">SN ${esc(subject.serial)}</div>`;
    if (own) t += `<div class="l-own">${esc(own)}</div>`;
    return `<div class="lab ${cls}${cp ? " compact" : ""}" style="width:${mm(w)}mm;height:${mm(h)}mm">${qrSvg}<div class="txt">${t}</div></div>`;
  }

  /* ---------------------------------- planche ---------------------------------- */

  /** UNE page de planche A4 : en-tête hors zone (source · compte/date) + grille de
      cellules. `cellsHtml` = étiquettes de CETTE page (≤ perPage), déjà rendues aux
      cotes de la cellule. `cuts` = traits de coupe pointillés (désactivables). */
  static sheetPage(cellsHtml: string[], layout: { cols: number; cellH: number }, opts: { source: string; headRight: string; cuts: boolean }): string {
    const esc = Html.escape;
    const cells = cellsHtml.map((c) => `<div class="cell${opts.cuts ? "" : " nocut"}" style="height:${+layout.cellH.toFixed(2)}mm">${c}</div>`).join("");
    return `<div class="a4" style="grid-template-columns:repeat(${layout.cols},1fr)">`
      + `<div class="a4-head"><span>${esc(opts.source)}</span><span>${esc(opts.headRight)}</span></div>${cells}</div>`;
  }

  /* ----------------------------- document d'impression ----------------------------- */

  /** Document d'IMPRESSION complet (iframe isolée) : print-CSS embarquée noir sur
      blanc, `@page` à la taille voulue — `pageSize` = `"A4"` (planche) ou
      `"<w>mm <h>mm"` (unitaire : page à la taille EXACTE de l'étiquette, ce qui
      passe tel quel sur une imprimante à rouleau Brother/Dymo). Les pages
      `.a4`/`.unit` se suivent avec saut de page. */
  static printDocument(opts: { title: string; pageSize: string; pagesHtml: string }): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${Html.escape(opts.title)}</title><style>`
      + `html,body{margin:0;padding:0;background:#fff}`
      + LabelHtml.CSS
      + `@page{size:${opts.pageSize};margin:0}`
      + `.label-render .a4,.label-render .unit{page-break-after:always}`
      + `.label-render .a4:last-child,.label-render .unit:last-child{page-break-after:auto}`
      + `</style></head><body><div class="label-render">${opts.pagesHtml}</div></body></html>`;
  }
}
