/* =============================================================================
   LABELIMAGEEXPORT — « Exporter en images » de la modale d'étiquettes (décision
   Q11.13). Documentation : docs/qr-scan.md § « Étiquettes imprimables ».

   LE BESOIN, mot pour mot : « que je puisse moi-même les ajouter dans un
   document ». Donc UNE IMAGE PAR ÉTIQUETTE (on les pose une à une), en PNG (un
   QR est du trait pur : le JPEG y fabrique exactement le halo qui fait rater un
   scan), et une ARCHIVE dès qu'il y en a plus d'une — le navigateur ne sait pas
   déposer 150 fichiers sans 150 confirmations.

   FIDÉLITÉ PAR CONSTRUCTION : on rasterise le MÊME HTML que l'aperçu et que
   l'imprimé (`core/LabelHtml`), enveloppé dans un `<foreignObject>` avec la MÊME
   CSS et la MÊME fonte embarquée. Aucun second rendu, donc aucune divergence
   possible — c'est la raison pour laquelle la voie « produire un SVG vectoriel
   de l'étiquette » a été écartée : elle aurait fait deux sources de vérité pour
   le même dessin, et les cinq pièges d'impression seraient à repayer sur la
   seconde.

   🚨 LE QR EST DESSINÉ DEPUIS SA MATRICE, JAMAIS MIS À L'ÉCHELLE (diagnostic
   Q11.14). Rasteriser le SVG du QR hériterait du défaut qu'on vient de corriger
   côté serveur : à 5,76 pixels par module, le rasteur en met tantôt 5, tantôt 6,
   et les modules cessent d'être carrés. On récupère donc la MATRICE
   (`?format=matrix`), on la peint sur un canvas à `k` pixels ENTIERS par module
   (`core/LabelExportPlan.qrPixels`), et on injecte le résultat comme
   `<img src="data:image/png;base64,…">` à la place du SVG. La boîte du QR fait
   alors `k × totalModules` pixels EXACTEMENT : ses modules sont carrés par
   construction, sans dépendre d'aucun moteur de rendu.

   ⚠ SAFARI. Un canvas « sali » par un `foreignObject` refuse d'être exporté
   (`SecurityError` à `toBlob`). Il n'existe pas de contournement propre — on
   attrape et on DIT que ce navigateur ne sait pas le faire, plutôt que de
   proposer un repli dégradé qui produirait des étiquettes fausses.
   ============================================================================= */

import { BlobWriter, BlobReader, ZipWriter } from "@zip.js/zip.js";
import { ImageExport } from "./ImageExport";
import { Notify } from "./Notify";
import { I18n } from "../i18n/I18n";
import { LabelHtml } from "../core/LabelHtml";
import type { LabelFieldChoice } from "../core/LabelHtml";
import { LabelLayout } from "../core/LabelLayout";
import type { LabelSpec, LabelDpi } from "../core/LabelLayout";
import { LabelExportPlan } from "../core/LabelExportPlan";
import type { LabelQrMatrix } from "../core/LabelExportPlan";
import type { LabelPrintItem } from "../core/LabelPrintPolicy";

/** Tout ce dont l'export a besoin — passé par la modale, qui reste la seule à connaître
    l'état du tirage. Aucune dépendance à `LabelPrintDialog` : le sens de la flèche est
    modale → export, jamais l'inverse. */
export interface LabelImageExportRequest {
  items: LabelPrintItem[];
  spec: LabelSpec;
  dpi: LabelDpi;
  /** Libellé de la source — base du nom de fichier et en-tête des planches. */
  source: string;
  cols: number;
  cuts: boolean;
  /** CSS complète du rendu (fonte embarquée + `LabelHtml.CSS`) — inlinée dans le SVG. */
  css: string;
  headRight: string;
  choice: Omit<LabelFieldChoice, "localEnd">;
  fetchMatrix(collection: string, id: string): Promise<LabelQrMatrix>;
  /** Faux pour les manchons : pas de QR à récupérer ni à dessiner. */
  needQr: boolean;
  /** `labels` = une image PAR ÉTIQUETTE (le besoin premier : les poser une à une dans un
      document) ; `sheets` = la PLANCHE entière, une image par feuille A4 (option offerte
      quand le tirage EST une planche : on veut parfois la page telle qu'elle s'imprime). */
  mode: "labels" | "sheets";
}

export class LabelImageExport {
  /** Exporte le tirage. Rend une promesse RÉSOLUE dans tous les cas gérés (l'appelant s'en
      sert seulement pour rendre le bouton) : les échecs sont dits par un toast, jamais par
      une exception qui remonterait dans un gestionnaire de clic. */
  static async run(req: LabelImageExportRequest): Promise<void> {
    const t = (key: string, vars?: Record<string, unknown>) => I18n.t("labels." + key, vars);
    try {
      const base = ImageExport.fileBase(req.source, "etiquettes");
      const matrices = req.needQr ? await LabelImageExport.loadMatrices(req) : new Map<string, LabelQrMatrix>();
      const images = req.mode === "sheets"
        ? await LabelImageExport.renderSheets(req, matrices)
        : await LabelImageExport.renderAll(req, matrices);
      const nameOf = (index: number) => req.mode === "sheets"
        ? LabelExportPlan.sheetFileName(base, index, images.length)
        : LabelExportPlan.fileName(base, index, images.length);
      if (!images.length) { Notify.toast(t("export.empty"), "err"); return; }
      if (images.length === 1) {
        ImageExport.download(nameOf(0), images[0]);
      } else {
        // Plus d'une image ⇒ UNE archive : un navigateur qui reçoit 150 téléchargements
        // demande 150 confirmations, et l'ordre de pose se perd dans le dossier.
        const zip = new ZipWriter(new BlobWriter("application/zip"));
        for (let i = 0; i < images.length; i++) await zip.add(nameOf(i), new BlobReader(images[i]));
        ImageExport.download(LabelExportPlan.zipName(base), await zip.close());
      }
      Notify.toast(t("export.done", { n: images.length, s: images.length > 1 ? "s" : "" }));
    } catch (e: any) {
      // Safari : `toBlob` sur un canvas sali par un foreignObject. Rien à contourner — on le dit.
      if (e && (e.name === "SecurityError" || /tainted|SecurityError/i.test(String(e.message || "")))) {
        Notify.toast(t("export.unsupported"), "err");
      } else {
        Notify.toast(t("export.failed", { msg: (e && e.message) || String(e) }), "err");
      }
    }
  }

  /** Matrices de QR des sujets du tirage, DÉDUPLIQUÉES par fiche : un drapeau tiré en A+B ×
      3 ne demande qu'UNE matrice au serveur, pas six. */
  private static async loadMatrices(req: LabelImageExportRequest): Promise<Map<string, LabelQrMatrix>> {
    const out = new Map<string, LabelQrMatrix>();
    const keys = new Map<string, { collection: string; id: string }>();
    for (const item of req.items) keys.set(item.subject.collection + "/" + item.subject.id, { collection: item.subject.collection, id: item.subject.id });
    await Promise.all([...keys.entries()].map(async ([key, ref]) => {
      out.set(key, await req.fetchMatrix(ref.collection, ref.id));
    }));
    return out;
  }

  /** UNE image par étiquette, dans l'ordre du tirage (donc dans l'ordre de pose). */
  private static async renderAll(req: LabelImageExportRequest, matrices: Map<string, LabelQrMatrix>): Promise<Blob[]> {
    const [w, h] = LabelLayout.labelDims(req.spec);
    const outW = LabelExportPlan.pixels(w, req.dpi);
    const outH = LabelExportPlan.pixels(h, req.dpi);
    const out: Blob[] = [];
    for (const item of req.items) {
      const matrix = matrices.get(item.subject.collection + "/" + item.subject.id) || null;
      const qr = req.needQr ? LabelImageExport.qrImageTag(matrix, req.spec, req.dpi) : "";
      const html = LabelHtml.label(item.subject, req.spec, { ...req.choice, localEnd: item.localEnd }, qr);
      out.push(await LabelImageExport.rasterize(html, req.css, w, h, outW, outH));
    }
    return out;
  }

  /** La PLANCHE entière, une image par feuille A4 — le MÊME `sheetPage` que l'aperçu et que
      l'imprimé, traits de coupe compris (option « la planche entière en une image »). */
  private static async renderSheets(req: LabelImageExportRequest, matrices: Map<string, LabelQrMatrix>): Promise<Blob[]> {
    const layout = LabelLayout.sheetLayout(req.spec, req.cols, req.items.length);
    const outW = LabelExportPlan.pixels(LabelLayout.A4_W, req.dpi);
    const outH = LabelExportPlan.pixels(LabelLayout.A4_H, req.dpi);
    const out: Blob[] = [];
    for (let page = 0; page < layout.pages; page++) {
      const pageItems = req.items.slice(page * layout.perPage, (page + 1) * layout.perPage);
      const cells = pageItems.map((item) => {
        const matrix = matrices.get(item.subject.collection + "/" + item.subject.id) || null;
        const qr = req.needQr ? LabelImageExport.qrImageTag(matrix, req.spec, req.dpi, layout.cellH) : "";
        return LabelHtml.label(item.subject, req.spec, { ...req.choice, localEnd: item.localEnd }, qr, [layout.cellW, layout.cellH]);
      });
      const html = LabelHtml.sheetPage(cells, layout, { source: req.source, headRight: req.headRight, cuts: req.cuts });
      out.push(await LabelImageExport.rasterize(html, req.css, LabelLayout.A4_W, LabelLayout.A4_H, outW, outH));
    }
    return out;
  }

  /** Le QR en `<img>` PNG dessiné DEPUIS LA MATRICE — cf. l'en-tête. La cote en mm posée sur
      la balise est celle que la quantification donne : la boîte du QR dans l'image mesure
      donc `k × totalModules` pixels tout rond une fois le SVG rasterisé au même dpi. */
  private static qrImageTag(matrix: LabelQrMatrix | null, spec: LabelSpec, dpi: LabelDpi, heightMm?: number): string {
    const total = LabelExportPlan.totalModulesOf(matrix);
    if (!matrix || total <= 0) return "";
    const wanted = LabelLayout.renderQrMm(spec, heightMm, { dpi, totalModules: total });
    const plan = LabelExportPlan.qrPixels(total, dpi, wanted);
    const url = LabelImageExport.matrixToDataUrl(matrix, plan.pxPerModule);
    const mm = +plan.mm.toFixed(2);
    return `<img src="${url}" width="${mm}mm" height="${mm}mm" alt="" style="width:${mm}mm;height:${mm}mm;display:block;flex:none">`;
  }

  /** Matrice → PNG en data: URI, `k` pixels par module. On dessine des RECTANGLES pleins sur
      un fond blanc : aucune interpolation n'entre en jeu (contrairement à une mise à
      l'échelle d'image), donc aucun module ne peut être rogné ni étalé. La quiet zone est
      peinte avec le reste — elle fait partie du code, pas de sa présentation. */
  private static matrixToDataUrl(matrix: LabelQrMatrix, pxPerModule: number): string {
    const margin = Number.isFinite(matrix.margin) ? matrix.margin : 0;
    const total = matrix.size + 2 * margin;
    const side = total * pxPerModule;
    const canvas = document.createElement("canvas");
    canvas.width = side; canvas.height = side;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, side, side);
    ctx.fillStyle = "#000000";
    for (let y = 0; y < matrix.rows.length; y++) {
      const row = matrix.rows[y];
      for (let x = 0; x < row.length; x++) {
        if (row[x] === "1") ctx.fillRect((x + margin) * pxPerModule, (y + margin) * pxPerModule, pxPerModule, pxPerModule);
      }
    }
    return canvas.toDataURL("image/png");
  }

  /** HTML d'étiquette → PNG. Enveloppe dans un SVG à `foreignObject`, puis passe au rasteriseur.

      🚨 DEUX SYSTÈMES D'UNITÉS, ET IL FAUT LES DEUX (cf. `LabelExportPlan.cssPixels`) :
        · le **viewBox** est en pixels CSS — c'est là-dedans que le HTML en millimètres se met en
          page (dans un `foreignObject`, un `mm` vaut 96/25,4 unités, pas `dpi`/25,4). Le poser en
          pixels de sortie ferait tenir l'étiquette dans un tiers de l'image, calée en haut à gauche ;
        · les attributs **`width`/`height`** portent la cote de SORTIE en pixels. Le rasteriseur
          dessine donc le VECTEUR directement à la résolution voulue, plutôt que d'agrandir une
          bitmap déjà rendue à 96 dpi (qui serait floue).
      Corollaire heureux : le facteur entre les deux vaut exactement `dpi/96`, donc l'image de QR,
      posée à `mm` en CSS, retombe sur `k × modules` pixels de sortie — **1:1 par construction**. */
  private static rasterize(html: string, css: string, wMm: number, hMm: number, outW: number, outH: number): Promise<Blob> {
    const vbW = LabelExportPlan.cssPixels(wMm), vbH = LabelExportPlan.cssPixels(hMm);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${+vbW.toFixed(3)} ${+vbH.toFixed(3)}">`
      + `<foreignObject width="100%" height="100%">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" class="label-render"><style>${css}</style>${html}</div>`
      + `</foreignObject></svg>`;
    return ImageExport.svgToPngBlob(svg, outW, outH, "#ffffff");
  }
}
