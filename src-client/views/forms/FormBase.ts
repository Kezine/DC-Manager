import type { Store } from "../../store";
import type { ImageStore } from "../../data/ImageStore";
import { FormControls } from "../../ui/FormControls";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Depths } from "../../registries/Depths";
import { PortTypes } from "../../registries/PortTypes";
import { EquipFaces } from "../../registries/EquipFaces";
import { RackGeometry } from "../../geometry/RackGeometry";
import { FreeEquipGeometry } from "../../geometry/FreeEquipGeometry";
import { RackScene } from "../../geometry/RackScene";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { RackItemKinds } from "../../domain/RackItemKinds";
import {
  RACK_FACES,
  SIDE_U_STEP,
  BREAKOUT_SPANS,
  EQUIP_FACE_IMG_FIELD,
  U_MM,
  RACK_MOUNT_WIDTH,
  RACK_EAR_MM
} from "../../domain/constants";
import { Schema } from "../../../src-shared/Schema";   // types MIME d'images acceptés — liste PARTAGÉE (le serveur applique la même)
import { I18n } from "../../i18n/I18n";

export class FormBase {
  /** Bibliothèque d'images de façade (injectée au boot) — singleton applicatif (hors modèle). */
  static images: ImageStore | null = null;

  /** Catégorie de bibliothèque d'une face : annexe (top/bottom/left/right) → « autre » ; sinon front/rear. */
  protected static faceAnnex(face: string): boolean { return face !== "front" && face !== "rear"; }
  /** Images éligibles pour une face. En mode LIBRE (`free`), AUCUN filtre : toute la bibliothèque (toute face, tout U).
      Sinon : annexe → « autre » ; front/rear → même face + même U (contrainte de baie 19″). */
  protected static eligibleImages(u: number, face: string, free = false): any[] {
    const im = this.images; if (!im) return [];
    if (free) return im.list();
    if (this.faceAnnex(face)) return im.list().filter((fi: any) => fi.face === "autre");
    const f = (face === "rear") ? "rear" : "front";
    return im.list().filter((fi: any) => fi.face === f && fi.u_height === (u || 1));
  }

  /** Ratio l/h RÉEL d'une image de façade (préréglage du redressement de perspective) : panneau 19″ complet
      (avec oreilles) ou corps seul, hauteur U × 44,45 mm. Face « autre » → null (aucun format imposé). */
  protected static faceImageRatio(face: string, u: number, withEars: boolean): number | null {
    if (face !== "front" && face !== "rear") return null;
    const w = (face === "front" && withEars) ? RACK_MOUNT_WIDTH : (RACK_MOUNT_WIDTH - 2 * RACK_EAR_MM);
    return w / (Math.max(1, u || 1) * U_MM);
  }
  /** Libellé du préréglage façade (bouton de l'éditeur de perspective). */
  protected static faceImageRatioLabel(face: string, u: number, withEars: boolean): string {
    const uu = Math.max(1, u || 1);
    if (face !== "front") return I18n.t("forms.faceRatio.rear", { u: uu });
    return I18n.t(withEars ? "forms.faceRatio.frontEars" : "forms.faceRatio.frontNoEars", { u: uu });
  }
  protected static configureBreakout(store: Store): Promise<{ name: string; trunkTypeId: string; laneTypeId: string; count: number } | null> {
    const types = store.all("portTypes").slice().sort((a: any, b: any) => (a.family || "").localeCompare(b.family || "") || a.name.localeCompare(b.name));
    if (!types.length) { Notify.toast(I18n.t("forms.breakout.needPortTypes"), "err"); return Promise.resolve(null); }
    const connOf = (t: any) => (t.connector || t.family || "").toUpperCase();
    const guessTrunk = types.find((t: any) => connOf(t).startsWith("QSFP")) || types[0];
    const guessLane = types.find((t: any) => connOf(t) === "SFP+") || types.find((t: any) => connOf(t).startsWith("SFP")) || types[0];
    // regroupés par FAMILLE (<optgroup>) ; le connecteur, s'il diffère de la famille, reste dans le libellé.
    const typeOpts = types.map((t: any) => ({ value: t.id, label: t.name + (t.connector && t.connector !== t.family ? " (" + t.connector + ")" : ""), group: t.family || "(sans famille)" }));
    const nameI = FormControls.text("QSFP1", I18n.t("forms.breakout.namePlaceholder"));
    const trunkSel = FormControls.select(typeOpts, guessTrunk ? guessTrunk.id : "");
    const laneSel = FormControls.select(typeOpts, guessLane ? guessLane.id : "");
    const spanWrap = document.createElement("div");
    let span: number | null = null;   // nb de lanes retenu (null = combinaison invalide)
    const speedOf = (id: string) => { const t: any = store.get("portTypes", id); return { g: t ? PortTypes.speedGbps(t.speed) : null, s: t ? (t.speed || "") : "" }; };
    const refreshSpan = () => {
      spanWrap.innerHTML = "";
      const tk = speedOf(trunkSel.value), ln = speedOf(laneSel.value);
      if (tk.g && ln.g) {
        const ratio = tk.g / ln.g;
        const h = document.createElement("div"); h.className = "form-hint";
        if (Number.isInteger(ratio) && BREAKOUT_SPANS.includes(ratio)) {
          span = ratio;
          h.innerHTML = I18n.t("forms.breakout.lanes", { n: ratio, trunk: Html.escape(tk.s), lane: Html.escape(ln.s) });
        } else {
          span = null; h.style.color = "var(--err)";
          h.textContent = I18n.t("forms.breakout.nonStandard", { trunk: tk.s, lane: ln.s, ratio: (Number.isInteger(ratio) ? ratio : ratio.toFixed(2)), spans: "{" + BREAKOUT_SPANS.join(", ") + "}" });
        }
        spanWrap.appendChild(h);
      } else {   // débit non renseigné (fibre, USB…) → choix manuel
        const sel = FormControls.select(BREAKOUT_SPANS.map((n) => ({ value: String(n), label: I18n.t("forms.breakout.laneOpt", { n }) })), String(span && BREAKOUT_SPANS.includes(span) ? span : 4));
        span = parseInt(sel.value, 10);
        sel.onchange = () => { span = parseInt(sel.value, 10); };
        spanWrap.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.lanesField"), sel, I18n.t("forms.breakout.lanesManualHint")));
      }
    };
    trunkSel.onchange = refreshSpan; laneSel.onchange = refreshSpan; refreshSpan();
    return Dialog.custom({
      title: I18n.t("forms.breakout.title"), confirmLabel: I18n.t("forms.breakout.create"),
      build: (root) => {
        root.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.nameField"), nameI, I18n.t("forms.breakout.nameHint")));
        root.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.trunkField"), trunkSel, I18n.t("forms.breakout.trunkHint")));
        root.appendChild(FormControls.fieldRow(I18n.t("forms.breakout.laneField"), laneSel, I18n.t("forms.breakout.laneHint")));
        root.appendChild(spanWrap);
        return {
          validate: () => {
            if (!nameI.value.trim()) return I18n.t("forms.breakout.errName");
            if (!trunkSel.value) return I18n.t("forms.breakout.errTrunk");
            if (!laneSel.value) return I18n.t("forms.breakout.errLane");
            if (!span) return I18n.t("forms.breakout.errCombo", { spans: "{" + BREAKOUT_SPANS.join(", ") + "}" });
            return true as const;
          },
          collect: () => ({ name: nameI.value.trim(), trunkTypeId: trunkSel.value, laneTypeId: laneSel.value, count: span as number }),
        };
      },
    });
  }

  /* ---- détail d'équipement (fiche riche : identité · façade · ports · agrégats · câbles + Modifier) ---- */
  protected static dt(label: string): HTMLElement { const e = document.createElement("div"); e.className = "dt"; e.textContent = label; return e; }
  protected static dd(html: string): HTMLElement { const e = document.createElement("div"); e.className = "dd"; e.innerHTML = html; return e; }
  /** Mode VISUALISEUR autonome (lecture seule) ? → on retire les entrées d'ÉDITION des fiches (façade, « Modifier »…). */
  protected static isViewer(): boolean { return typeof document !== "undefined" && document.body.classList.contains("viewer-mode"); }
  /** Bits de localisation d'un équipement (hérités du rack / de la salle, ou saisis). */
  protected static equipLocationBits(store: Store, e: any): string[] {
    const bits = (loc: any, fl: any, rm: any) => [store.siteLabel(loc || ""), fl, rm].filter((x) => x && x !== "—");
    if ((e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id) { const rk: any = store.get("racks", e.rack_id); return rk ? bits(rk.location, rk.floor, rk.room) : []; }
    if (e.dim_mode === "free" && e.dc_id) { const dc: any = store.get("datacenters", e.dc_id); if (dc) return bits(dc.location, dc.floor, dc.room); }
    return bits(e.location, e.floor, e.room);
  }
  /** Aperçu d'une face : fond image (si attachée) + ports posés. null si rien.
      Deux rendus (fiche détail, lecture seule) :
      - CLASSIQUE (défaut) : étiquettes posées SUR les ports (peut se chevaucher si façade dense) ;
      - HAUTE DENSITÉ (`dense`) : pastilles seules + RANGÉE DE CHIPS sous la face (même présentation que la
        palette « ports à poser » de l'éditeur) ; survol CROISÉ pastille ↔ chip avec bulle déportée reliée. */
  protected static facePreview(store: Store, eq: any, face: string, dense = false): HTMLElement | null {
    const url = (this.images && eq[(EQUIP_FACE_IMG_FIELD as any)[face]]) ? (this.images.get(eq[(EQUIP_FACE_IMG_FIELD as any)[face]]) || {}).url || null : null;
    const ports = store.portsOf(eq.id).filter((p: any) => p.face_x != null && p.face_y != null && EquipFaces.norm(p.face_side) === face);
    if (!url && !ports.length) return null;
    const isFree = eq.dim_mode === "free";
    // Aspect-ratio PAR FACE (libre) : dessus/dessous = l×p, gauche/droite = p×h, etc. — sinon toutes les faces
    // prenaient les proportions avant/arrière. En mode U : panneau 19″ × hauteur en U. Largeur bornée par MAXVH×ratio
    // pour PRÉSERVER le ratio (width:100% + max-height seul l'aplatissait).
    const wh = isFree ? FreeEquipGeometry.faceWH(eq, face) : { W: 19, H: 1.75 * Math.max(1, eq.u_height || 1) };
    const MAXVH = 60;
    const stage = document.createElement("div"); stage.className = "face-preview";
    stage.style.aspectRatio = wh.W + " / " + wh.H;
    stage.style.maxHeight = MAXVH + "vh";
    stage.style.maxWidth = "calc(" + MAXVH + "vh * " + (wh.W / wh.H).toFixed(4) + ")";
    stage.style.margin = "0 auto";
    if (url) { const im = document.createElement("img"); im.className = "face-bg"; im.src = url; im.alt = ""; stage.appendChild(im); }
    const roleCls = (p: any) => p.role === "mgmt" ? " role-mgmt" : (p.role === "power" ? " role-power" : "");
    if (!dense) {
      ports.forEach((p: any) => { const mk = document.createElement("div"); mk.className = "face-marker" + roleCls(p); mk.style.left = (p.face_x * 100) + "%"; mk.style.top = (p.face_y * 100) + "%"; mk.textContent = p.name || "(port)"; stage.appendChild(mk); });
      return stage;
    }
    return this.facePreviewDense(stage, ports, roleCls);
  }

  /** Rendu HAUTE DENSITÉ de l'aperçu (cf. facePreview) : pastilles + chips + survol croisé avec bulle déportée.
      La bulle reste DANS le cadre (overflow:hidden du stage) : repli sous/au-dessus du port + clamp horizontal. */
  private static facePreviewDense(stage: HTMLElement, ports: any[], roleCls: (p: any) => string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.appendChild(stage);
    // couche du survol (ligne SVG + bulle) — au-dessus des pastilles, transparente aux événements.
    const NS = "http://www.w3.org/2000/svg";
    const hoverLayer = document.createElement("div"); hoverLayer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:5;"; stage.appendChild(hoverLayer);
    const dots = ports.map((p: any) => {
      const dot = document.createElement("div"); dot.className = "face-dot" + roleCls(p);
      dot.style.cursor = "default"; dot.title = p.name || "(port)";
      dot.style.left = (p.face_x * 100) + "%"; dot.style.top = (p.face_y * 100) + "%";
      stage.appendChild(dot); return dot;
    });
    // chips sous la face — même présentation que la palette « ports à poser » de l'éditeur de façade.
    const chipsRow = document.createElement("div"); chipsRow.className = "face-palette"; chipsRow.style.marginTop = "6px";
    const chips = ports.map((p: any) => { const c = document.createElement("span"); c.className = "face-chip"; c.style.cursor = "default"; c.textContent = p.name || "(port)"; chipsRow.appendChild(c); return c; });
    if (ports.length) wrap.appendChild(chipsRow);

    const show = (i: number) => {
      const p = ports[i];
      dots.forEach((d, j) => d.classList.toggle("dim", j !== i));
      dots[i].classList.add("hi"); chips[i].classList.add("hi");
      // bulle déportée DANS le cadre : sous le port s'il est en haut, au-dessus sinon (déport ∝ hauteur, borné).
      const by = p.face_y < 0.5 ? Math.min(0.9, p.face_y + 0.35) : Math.max(0.1, p.face_y - 0.35);
      const bubble = document.createElement("div"); bubble.className = "face-leader-label" + roleCls(p);
      bubble.textContent = p.name || "(port)";
      bubble.style.left = (p.face_x * 100) + "%"; bubble.style.top = (by * 100) + "%";
      hoverLayer.appendChild(bubble);
      // clamp HORIZONTAL (le stage clippe) : re-mesure puis borne le centre à [demi-largeur, 100%−demi-largeur].
      const sw = stage.clientWidth || 1, bw = bubble.getBoundingClientRect().width;
      const half = (bw / sw) / 2 + 0.005;
      const bx = Math.max(half, Math.min(1 - half, p.face_x));
      bubble.style.left = (bx * 100) + "%";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "face-leader-lines"); svg.setAttribute("viewBox", "0 0 100 100"); svg.setAttribute("preserveAspectRatio", "none");
      const ln = document.createElementNS(NS, "line");
      ln.setAttribute("x1", String(p.face_x * 100)); ln.setAttribute("y1", String(p.face_y * 100));
      ln.setAttribute("x2", String(bx * 100)); ln.setAttribute("y2", String(by * 100));
      ln.classList.add("hi"); svg.appendChild(ln);
      hoverLayer.insertBefore(svg, bubble);   // ligne sous la bulle
    };
    const clear = () => { hoverLayer.innerHTML = ""; dots.forEach((d) => d.classList.remove("dim", "hi")); chips.forEach((c) => c.classList.remove("hi")); };
    ports.forEach((_p: any, i: number) => {
      const on = () => { clear(); show(i); };
      dots[i].addEventListener("mouseenter", on); dots[i].addEventListener("mouseleave", clear);
      chips[i].addEventListener("mouseenter", on); chips[i].addEventListener("mouseleave", clear);
    });
    return wrap;
  }
  /** Éditeur de CAPOT (toit/sol) : grille SVG multi-sélection au glisser. Les cellules sont éditées dans un
      TAMPON fourni par l'appelant (`cells`) et ne sont PERSISTÉES qu'à l'enregistrement du formulaire de baie —
      l'ancienne sauvegarde immédiate doublait l'écriture (un save au changement de capot + un au bouton
      « Enregistrer ») et créait des pas d'undo/écritures REST parasites. Une cellule portant un pin (◆, waypoint
      posé) n'est pas retirable. */
  protected static capEditor(store: Store, rack: any, face: string, cells: { get: () => string[]; set: (v: string[]) => void }): { el: HTMLElement; refresh: () => void } {
    const NS = "http://www.w3.org/2000/svg";
    const wrap = document.createElement("div"); wrap.className = "cap-grid-wrap";
    const g = RackGeometry.capGrid(rack), nx = g.nx, ny = g.ny;
    const cellPx = Math.max(9, Math.min(26, Math.floor(340 / Math.max(nx, ny, 1))));
    const W = nx * cellPx, Hh = ny * cellPx;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(Hh)); svg.setAttribute("viewBox", "0 0 " + W + " " + Hh);
    svg.setAttribute("class", "cap-grid"); svg.style.cssText = "display:block;background:var(--bg-1,#15171c);border:1px solid var(--line-2,#333);border-radius:6px;touch-action:none;";
    wrap.appendChild(svg);
    const mk = (tag: string, attrs: Record<string, string | number>): SVGElement => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, String(attrs[k])); return n; };
    const cellsSet = () => new Set(cells.get());
    const occSet = () => { const s = new Set<string>(); store.all("waypoints").forEach((w: any) => { if (w.kind === "point" && w.rack_id === rack.id && w.cap_face === face) s.add((w.cap_cx | 0) + "," + (w.cap_cy | 0)); }); return s; };
    let prevRect: SVGElement | null = null;
    const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max - 1);
    // AFFICHAGE : façade EN BAS de la grille (rangée cy=0 en bas). Le stockage garde sa convention (cx → +X,
    // cy → +Y = vers l'arrière) : seule la rangée d'ÉCRAN est retournée (rowY). Ce retournement rend la vue de
    // dessus NON-MIROIR : « à droite » dans l'éditeur = « à droite » en 3D face à la baie (avant, l'ancienne
    // façade-en-haut affichait une vue en miroir → G/D inversés).
    const rowY = (cy: number) => (ny - 1 - cy) * cellPx;
    const cellAt = (clientX: number, clientY: number) => { const rb = svg.getBoundingClientRect(); return { cx: clamp(Math.floor((clientX - rb.left) / cellPx), nx), cy: clamp(ny - 1 - Math.floor((clientY - rb.top) / cellPx), ny) }; };
    const applyRange = (cx0: number, cy0: number, cx1: number, cy1: number): void => {
      const set = cellsSet(), occ = occSet();
      const add = !set.has(cx0 + "," + cy0);   // mode déduit de la 1re cellule
      let skipped = 0;
      for (let cx = Math.min(cx0, cx1); cx <= Math.max(cx0, cx1); cx++)
        for (let cy = Math.min(cy0, cy1); cy <= Math.max(cy0, cy1); cy++) {
          const k = cx + "," + cy;
          if (add) set.add(k); else { if (occ.has(k)) { skipped++; continue; } set.delete(k); }
        }
      cells.set([...set]);   // TAMPON local — persisté au clic sur « Enregistrer » du formulaire de baie
      if (skipped) Notify.toast(I18n.t("forms.cap.kept", { count: skipped }), "err");
      draw();
    };
    // « Supprimer tout » : retire tous les trous de ce capot. Les cellules portant un PIN sont conservées (comme la
    // suppression au glisser) — un pin exige un trou sous lui.
    const clearAll = (): void => {
      const occ = occSet();
      if (!cellsSet().size) return;   // rien à retirer
      cells.set([...occ]);   // TAMPON local — persisté au clic sur « Enregistrer » du formulaire de baie
      if (occ.size) Notify.toast(I18n.t("forms.cap.kept", { count: occ.size }), "err");
      draw();
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return; e.preventDefault();
      const c0 = cellAt(e.clientX, e.clientY);
      prevRect = mk("rect", { class: "cap-cell-sel-preview", x: c0.cx * cellPx, y: rowY(c0.cy), width: cellPx, height: cellPx });
      svg.appendChild(prevRect);
      let c1 = c0;
      // y d'écran du rectangle = rangée AFFICHÉE la plus haute = cy MAX (l'axe écran est retourné, cf. rowY).
      const drawSel = (c: { cx: number; cy: number }) => { const x0 = Math.min(c0.cx, c.cx), cyMax = Math.max(c0.cy, c.cy); prevRect!.setAttribute("x", String(x0 * cellPx)); prevRect!.setAttribute("y", String(rowY(cyMax))); prevRect!.setAttribute("width", String((Math.abs(c.cx - c0.cx) + 1) * cellPx)); prevRect!.setAttribute("height", String((Math.abs(c.cy - c0.cy) + 1) * cellPx)); };
      const move = (ev: MouseEvent) => { c1 = cellAt(ev.clientX, ev.clientY); drawSel(c1); };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); if (prevRect) { prevRect.remove(); prevRect = null; } applyRange(c0.cx, c0.cy, c1.cx, c1.cy); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
    function draw(): void {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const auth = cellsSet(), occ = occSet();
      auth.forEach((k) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; svg.appendChild(mk("rect", { x: cx * cellPx, y: rowY(cy), width: cellPx, height: cellPx, class: "cap-cell-auth" })); });
      occ.forEach((k) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; const mx = (cx + 0.5) * cellPx, my = rowY(cy) + 0.5 * cellPx, rr = cellPx * 0.3; svg.appendChild(mk("polygon", { points: `${mx},${my - rr} ${mx + rr},${my} ${mx},${my + rr} ${mx - rr},${my}`, class: "cap-cell-pin" })); });
      for (let i = 0; i <= nx; i++) svg.appendChild(mk("line", { x1: i * cellPx, y1: 0, x2: i * cellPx, y2: Hh, class: "cap-grid-line" }));
      for (let j = 0; j <= ny; j++) svg.appendChild(mk("line", { x1: 0, y1: j * cellPx, x2: W, y2: j * cellPx, class: "cap-grid-line" }));
      svg.appendChild(mk("line", { x1: 0, y1: Hh - 1, x2: W, y2: Hh - 1, class: "cap-grid-front" }));   // bord INFÉRIEUR = face AVANT (cf. rowY)
      const ov = mk("rect", { x: 0, y: 0, width: W, height: Hh, class: "cap-grid-ov" });
      ov.addEventListener("mousedown", onDown as EventListener);
      svg.appendChild(ov);
    }
    draw();
    const bar = document.createElement("div"); bar.style.cssText = "display:flex;justify-content:center;margin-top:6px";
    const clearBtn = document.createElement("button"); clearBtn.type = "button"; clearBtn.className = "btn btn-ghost btn-sm";
    clearBtn.textContent = I18n.t("forms.cap.clearAll"); clearBtn.title = I18n.t("forms.cap.clearAllTitle");
    clearBtn.onclick = () => { clearAll(); };
    bar.appendChild(clearBtn); wrap.appendChild(bar);
    return { el: wrap, refresh: draw };
  }

  /** Demande un fichier image à l'utilisateur (input file, JPEG/PNG/WebP). */
  protected static promptImageFile(): Promise<File | null> {
    return new Promise((resolve) => {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = Schema.IMAGE_MIME_TYPES.join(","); inp.style.display = "none";
      inp.onchange = () => { const f = inp.files && inp.files[0] ? inp.files[0] : null; inp.remove(); resolve(f); };
      document.body.appendChild(inp); inp.click();
    });
  }
  /** Variante MULTI-fichiers (un SEUL dialogue). NE PAS enchaîner deux promptImageFile : le premier
      consomme l'activation utilisateur (le clic) et le navigateur BLOQUE silencieusement le second
      `input.click()` programmatique — la promesse ne se résout jamais (flux suspendu sans erreur). */
  protected static promptImageFiles(): Promise<File[]> {
    return new Promise((resolve) => {
      const inp = document.createElement("input"); inp.type = "file"; inp.multiple = true; inp.accept = Schema.IMAGE_MIME_TYPES.join(","); inp.style.display = "none";
      inp.onchange = () => { const fs = inp.files ? Array.from(inp.files) : []; inp.remove(); resolve(fs); };
      document.body.appendChild(inp); inp.click();
    });
  }
  protected static validImageFile(f: File | null): File | null {
    if (!f) return null;
    if (!Schema.isImageMime(f.type)) { Notify.toast(I18n.t("forms.image.badFormat"), "err"); return null; }
    return f;
  }
  protected static sideGrid(store: Store, scene: RackScene, rack: any, opts: any): { el: HTMLElement; refresh: () => void } {
    const wrap = document.createElement("div"); wrap.className = "rack-grid-wrap side-grid-wrap";
    const refresh = () => {
      const face = opts.face, cols = RackGeometry.sideColumns(rack), colW = RackGeometry.sideColWidthMm(rack);
      const heightU = Math.max(1, opts.heightU || 1), uMax = rack.u_count || 42;
      const fitsW = (opts.width || 0) <= colW + 0.5, sel = opts.selected;
      const occ = scene.sideOccupants(rack.id, face, null);
      const columns: Array<{ lr: string; col: number }> = []; ["left", "right"].forEach((lr) => { for (let c = 0; c < cols; c++) columns.push({ lr, col: c }); });
      const colLabel = (lr: string, c: number) => (lr === "left" ? I18n.t("forms.side.left") : I18n.t("forms.side.right")) + (cols > 1 ? String(c + 1) : "");
      const blockAt = (lr: string, col: number, u: number) => occ.find((e: any) => e.id !== opts.exceptEqId
        && ((e.side_lr === "right" ? "right" : "left") === lr) && ((e.side_col === 1 && cols > 1) ? 1 : 0) === col
        && u >= Math.max(1, e.side_u | 0) && u < Math.max(1, e.side_u | 0) + RackGeometry.sideEquipHeightU(e));
      const tops: number[] = []; for (let u = 1; u + heightU - 1 <= uMax; u += SIDE_U_STEP) tops.push(u);
      let html = '<table class="rack-grid side-grid"><thead><tr><th class="ru">U</th>';
      columns.forEach((cc, i) => { html += `<th>${colLabel(cc.lr, cc.col)}</th>`; if (i === cols - 1) html += `<th class="side-mid">${I18n.t("forms.side.bay")}</th>`; });
      html += "</tr></thead><tbody>";
      for (let ri = tops.length - 1; ri >= 0; ri--) {
        const uTop = tops[ri];
        html += `<tr><td class="ru">${uTop}${heightU > 1 ? "–" + (uTop + heightU - 1) : ""}</td>`;
        columns.forEach((cc, i) => {
          const blk: any = blockAt(cc.lr, cc.col, uTop);
          const isSel = sel && sel.lr === cc.lr && sel.col === cc.col && uTop >= sel.u && uTop < sel.u + heightU;
          if (blk) {
            const hU = RackGeometry.sideEquipHeightU(blk), range = "U" + blk.side_u + (hU > 1 ? "–U" + (blk.side_u + hU - 1) : "");
            html += `<td class="rcell occ" title="${Html.escape((blk.name || I18n.t("forms.ph.equipment")) + " · " + range + " · " + (cc.lr === "left" ? I18n.t("forms.side.marginLeft") : I18n.t("forms.side.marginRight")))}" style="border-left:3px solid var(--accent);"><div class="rcell-in compact"><span class="rcell-name">${Html.escape(blk.name || "")}</span></div></td>`;
          } else {
            const free = fitsW && scene.sideSlotFree(rack.id, face, cc.lr, cc.col, uTop, heightU, opts.exceptEqId || null);
            const cls = "rcell free" + (isSel ? " chosen mount-face" : (free ? " placeable" : ""));
            const attrs = free ? `data-pick-lr="${cc.lr}" data-pick-col="${cc.col}" data-pick-u="${uTop}"` : "";
            html += `<td class="${cls}" ${attrs}>${isSel ? `<div class="rcell-in compact"><span class="rcell-name">${I18n.t("forms.side.here")}</span></div>` : ""}</td>`;
          }
          if (i === cols - 1) html += '<td class="side-mid"></td>';
        });
        html += "</tr>";
      }
      html += "</tbody></table>";
      if (!fitsW) html += `<div class="form-hint" style="color:var(--warn);">${I18n.t("forms.side.tooWide", { w: opts.width || 0, col: Math.round(colW) })}</div>`;
      wrap.innerHTML = html;
      if (opts.onPick) wrap.querySelectorAll("[data-pick-u]").forEach((c: any) => {
        c.onclick = () => opts.onPick(c.getAttribute("data-pick-lr"), parseInt(c.getAttribute("data-pick-col"), 10), parseInt(c.getAttribute("data-pick-u"), 10));
      });
    };
    refresh();
    return { el: wrap, refresh };
  }
  /** Grille de sélection d'un trou de CAPOT autorisé (réplique `capPickGrid`) : SVG, cellules autorisées
      cliquables (onPick), cellules portant un pin marquées (◆, non sélectionnables). */
  protected static capPickGrid(store: Store, rack: any, face: string, opts: any): { el: HTMLElement; refresh: () => void } {
    const NS = "http://www.w3.org/2000/svg";
    const wrap = document.createElement("div"); wrap.className = "cap-grid-wrap";
    const g = RackGeometry.capGrid(rack), nx = g.nx, ny = g.ny;
    const cellPx = Math.max(9, Math.min(26, Math.floor(340 / Math.max(nx, ny, 1))));
    const W = nx * cellPx, Hh = ny * cellPx;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(Hh)); svg.setAttribute("viewBox", "0 0 " + W + " " + Hh);
    svg.style.cssText = "display:block;background:var(--bg-1,#15171c);border:1px solid var(--line-2,#333);border-radius:6px;";
    wrap.appendChild(svg);
    const mk = (tag: string, attrs: Record<string, any>, on?: () => void): SVGElement => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, String(attrs[k])); if (on) n.addEventListener("click", on); return n as SVGElement; };
    let sel = opts.selected || null;
    const draw = () => {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const occ = new Set<string>(); store.all("waypoints").forEach((w: any) => { if (w.kind === "point" && w.rack_id === rack.id && w.cap_face === face && w.id !== opts.exceptId) occ.add((w.cap_cx | 0) + "," + (w.cap_cy | 0)); });
      RackGeometry.capCells(rack, face).forEach((k: string) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return;
        const occupied = occ.has(cx + "," + cy), isSel = sel && sel.cx === cx && sel.cy === cy;
        svg.appendChild(mk("rect", { x: cx * cellPx, y: cy * cellPx, width: cellPx, height: cellPx, class: "cap-cell-auth",
          style: "pointer-events:auto;cursor:" + (occupied ? "not-allowed" : "pointer") + ";" + (isSel ? "fill-opacity:0.6;" : "") },
          occupied ? undefined : () => { sel = { cx, cy }; if (opts.onPick) opts.onPick(cx, cy); draw(); }));
        if (occupied) { const mx = (cx + 0.5) * cellPx, my = (cy + 0.5) * cellPx, rr = cellPx * 0.3; svg.appendChild(mk("polygon", { points: `${mx},${my - rr} ${mx + rr},${my} ${mx},${my + rr} ${mx - rr},${my}`, class: "cap-cell-pin" })); }
      });
      for (let i = 0; i <= nx; i++) svg.appendChild(mk("line", { x1: i * cellPx, y1: 0, x2: i * cellPx, y2: Hh, class: "cap-grid-line" }));
      for (let j = 0; j <= ny; j++) svg.appendChild(mk("line", { x1: 0, y1: j * cellPx, x2: W, y2: j * cellPx, class: "cap-grid-line" }));
      svg.appendChild(mk("line", { x1: 0, y1: 1, x2: W, y2: 1, class: "cap-grid-front" }));
    };
    draw();
    return { el: wrap, refresh: draw };
  }

  /** ÉLÉVATION cliquable d'une baie (grille des U) — mode « gérer le contenu ». Sœur de `sideGrid`/`capPickGrid`
      (constructeurs de grille de baie réutilisables). Réplique modulaire de `rackGrid` (monolithe v170) restreinte
      au mode GÉRER : cellule libre → bouton « + » (`onSlotClick(u, face)`) ; occupant → cellule pleine + « × »
      (`onRemove(kind, id)`). L'occupation vient de `RackScene.occupants` (source unique, partagée avec la 3D).
      Le mode « placer » (aperçu d'un gabarit, choix de position) reste au formulaire d'équipement. */
  protected static rackFrontGrid(store: Store, rack: any, opts: { onSlotClick: (u: number, face: string) => void; onRemove: (kind: string, id: string) => void }): { el: HTMLElement; refresh: () => void } {
    const scene = new RackScene(store);
    const faces = rack.sides === "dual" ? ["front", "rear"] : ["front"];
    const dual = rack.sides === "dual";
    const wrap = document.createElement("div"); wrap.className = "rack-grid-wrap";
    const faceBadge = (depth: string, side: string, f: string) => {
      if (!dual) return "";
      if (depth === "full") return f === side ? "▸ " + this.faceLabel(side) : this.faceLabel(f) + I18n.t("forms.rack.rearSuffix");
      return "▸ " + this.faceLabel(side);
    };
    const cellInner = (iconInner: string, name: string, sub: string, height: number) => {
      const icon = iconInner ? `<span class="ricon"><svg viewBox="0 0 24 24">${iconInner}</svg></span>` : "";
      const showSub = height >= 3 && sub;
      return `<div class="rcell-in${height === 1 ? " compact" : ""}">${icon}<span class="rcell-name">${Html.escape(name)}</span>${showSub ? `<span class="rcell-sub">${Html.escape(sub)}</span>` : ""}</div>`;
    };
    const refresh = () => {
      const occ = scene.occupants(rack.id);
      let html = '<table class="rack-grid"><thead><tr><th class="ru">U</th>' + faces.map((f) => `<th>${Html.escape(this.faceLabel(f))}</th>`).join("") + "</tr></thead><tbody>";
      for (let u = rack.u_count; u >= 1; u--) {
        html += `<tr><td class="ru">${u}</td>`;
        faces.forEach((f) => {
          const info: any = occ.get(u + ":" + f);
          if (info) {
            if ((info.top + info.height - 1) === u) {   // ne rend qu'à la cellule de TÊTE (rowspan couvre le reste)
              const isEq = info.kind === "equipment";
              const col = info.color || (isEq ? "var(--accent)" : "var(--line-2)");
              const mount = !dual || f === info.side;
              const badge = faceBadge(info.depth, info.side, f);
              const iconInner = isEq ? EquipmentTypes.icon(info.type) : RackItemKinds.icon(info.kind);
              const sub = (isEq ? "" : RackItemKinds.label(info.kind) + " · ") + info.height + " U · " + this.mountDepthLabel(info) + (badge ? " · " + badge : "");
              const uRange = "U" + info.top + (info.height > 1 ? "–U" + (info.top + info.height - 1) : "");
              const title = Html.escape((info.label || "") + " · " + uRange + " · " + info.height + " U");
              html += `<td class="rcell occ${mount ? " mount-face" : " back-face"}" rowspan="${info.height}" title="${title}" style="border-left:3px solid ${col};"><button class="row-btn danger" data-rm-kind="${info.kind}" data-rm-id="${info.id}" title="${I18n.t("forms.rack.remove")}">×</button>${cellInner(iconInner, info.label, sub, info.height)}</td>`;
            }
            return;   // cellule couverte par un rowspan
          }
          html += `<td class="rcell free"><button class="btn btn-ghost btn-sm rcell-add" data-add-u="${u}" data-add-face="${f}" title="${I18n.t("forms.rack.mount")}">+</button></td>`;
        });
        html += "</tr>";
      }
      html += "</tbody></table>";
      wrap.innerHTML = html;
      wrap.querySelectorAll("[data-rm-id]").forEach((b) => { (b as HTMLElement).onclick = () => opts.onRemove((b as HTMLElement).dataset.rmKind!, (b as HTMLElement).dataset.rmId!); });
      wrap.querySelectorAll("[data-add-u]").forEach((b) => { (b as HTMLElement).onclick = () => opts.onSlotClick(parseInt((b as HTMLElement).dataset.addU!, 10), (b as HTMLElement).dataset.addFace!); });
    };
    refresh();
    return { el: wrap, refresh };
  }

  /** Création / édition d'un plan d'étage (réplique `openFloorForm`). `opts.pick` = mode création (sélecteurs
      bâtiment+étage, étages existants exclus) ; `opts.onPicked(loc, fl)` = navigation après création. */

  protected static faceLabel(id: string): string { const f = RACK_FACES.find((x) => x.id === id); return f ? I18n.t(f.labelKey) : (id || "—"); }
  protected static mountDepthLabel(e: any): string { return (e && e.depth_mm != null) ? (e.depth_mm + " mm") : Depths.label((e && e.depth) || "full"); }
}
