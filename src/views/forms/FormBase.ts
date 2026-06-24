import type { Store } from "../../store";
import type { ImageStore } from "../../data/ImageStore";
import type { ModalOptions } from "../../ui/Modal";
import { FormControls } from "../../ui/FormControls";
import { ColorPalette } from "../../ui/ColorPalette";
import { Notify } from "../../ui/Notify";
import { Dialog } from "../../ui/Dialog";
import { Html } from "../../core/Html";
import { Text } from "../../core/Text";
import { Color } from "../../core/Color";
import { Format } from "../../core/Format";
import { FloorLayout } from "../../geometry/FloorLayout";
import { Ip } from "../../core/Ip";
import { GroupTypes } from "../../domain/GroupTypes";
import { CableStatuses } from "../../domain/CableStatuses";
import { SpareTypes } from "../../domain/SpareTypes";
import { SpareStatuses } from "../../domain/SpareStatuses";
import { Waypoint } from "../../models/Waypoint";
import { EquipmentTypes } from "../../registries/EquipmentTypes";
import { Depths } from "../../registries/Depths";
import { PortRoles } from "../../registries/PortRoles";
import { PortTypes } from "../../registries/PortTypes";
import { EquipFaces } from "../../registries/EquipFaces";
import { Id } from "../../core/Id";
import { RackGeometry } from "../../geometry/RackGeometry";
import { RackScene } from "../../geometry/RackScene";
import { RackItemKinds } from "../../domain/RackItemKinds";
import { Normalize } from "../../core/Normalize";
import {
  POWER_SOURCES, EQUIPMENT_TYPE_DEFAULT, LOCATIONS, FLOORS, RACK_SIDES, RACK_FACES, RACK_DEPTHS,
  RACK_WIDTH_DEFAULT, RACK_DEPTH_DEFAULT, RACK_MOUNT_WIDTH, RACK_MOUNT_MARGIN_DEFAULT, U_MM, SIDE_U_STEP,
  BREAKOUT_SPANS, CABLE_STATUS_DRAFT, CABLE_STATUS_DEFAULT_NEW,
  EQUIP_FACE_IDS, EQUIP_FACE_IMG_FIELD, EQUIP_FREE_DEFAULT_MM,
  WAYPOINT_TYPES, OOB_HEIGHT_DEFAULT, WAYPOINT_Z_DEFAULT, CONDUIT_W_DEFAULT, CONDUIT_H_DEFAULT, BRUSH_PADDING_MM,
  FLOOR_WIDTH_DEFAULT, FLOOR_DEPTH_DEFAULT, FLOOR_CELL_DEFAULT,
  SPARE_DISK_TYPES, SPARE_CAP_UNITS, SPARE_HDD_INTERFACES, SPARE_HDD_FORMATS, SPARE_HDD_RPM,
  SPARE_TX_FORMS, SPARE_TX_SPEEDS, SPARE_TX_MEDIA,
} from "../../domain/constants";
import { row2, divider, locOptions, floorOptions, setOptions, ipNetOptions, eqOptions, WAYPOINT_KIND_LABELS } from "./shared";
import type { FormHost } from "./shared";

export class FormBase {
  /** Bibliothèque d'images de façade (injectée au boot) — singleton applicatif (hors modèle). */
  static images: ImageStore | null = null;

  /** Catégorie de bibliothèque d'une face : annexe (top/bottom/left/right) → « autre » ; sinon front/rear. */
  protected static faceAnnex(face: string): boolean { return face !== "front" && face !== "rear"; }
  /** Images éligibles pour une face : annexe → « autre » (sans filtre U) ; front/rear → même U + même face. */
  protected static eligibleImages(u: number, face: string): any[] {
    const im = this.images; if (!im) return [];
    if (this.faceAnnex(face)) return im.list().filter((fi: any) => fi.face === "autre");
    const f = (face === "rear") ? "rear" : "front";
    return im.list().filter((fi: any) => fi.u_height === (u || 1) && fi.face === f);
  }
  protected static configureBreakout(store: Store): Promise<{ name: string; trunkTypeId: string; laneTypeId: string; count: number } | null> {
    const types = store.all("portTypes").slice().sort((a: any, b: any) => a.name.localeCompare(b.name));
    if (!types.length) { Notify.toast("Créez d'abord des types de port (QSFP+ et SFP+).", "err"); return Promise.resolve(null); }
    const connOf = (t: any) => (t.connector || t.family || "").toUpperCase();
    const guessTrunk = types.find((t: any) => connOf(t).startsWith("QSFP")) || types[0];
    const guessLane = types.find((t: any) => connOf(t) === "SFP+") || types.find((t: any) => connOf(t).startsWith("SFP")) || types[0];
    const typeOpts = types.map((t: any) => ({ value: t.id, label: t.name + " · " + t.family + (t.connector && t.connector !== t.family ? " (" + t.connector + ")" : "") }));
    const nameI = FormControls.text("QSFP1", "ex. QSFP1");
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
          h.innerHTML = "Nombre de lanes : <b>×" + ratio + "</b>  (" + Html.escape(tk.s) + " ÷ " + Html.escape(ln.s) + " = " + ratio + " — breakout standard).";
        } else {
          span = null; h.style.color = "var(--err)";
          h.textContent = "Combinaison non standard : " + tk.s + " ÷ " + ln.s + " = " + (Number.isInteger(ratio) ? ratio : ratio.toFixed(2)) + ". Un breakout valide impose débit(trunk) = N × débit(lane) avec N ∈ {" + BREAKOUT_SPANS.join(", ") + "}.";
        }
        spanWrap.appendChild(h);
      } else {   // débit non renseigné (fibre, USB…) → choix manuel
        const sel = FormControls.select(BREAKOUT_SPANS.map((n) => ({ value: String(n), label: "×" + n + " lanes" })), String(span && BREAKOUT_SPANS.includes(span) ? span : 4));
        span = parseInt(sel.value, 10);
        sel.onchange = () => { span = parseInt(sel.value, 10); };
        spanWrap.appendChild(FormControls.fieldRow("Nombre de lanes", sel, "Débit non renseigné sur ces types → choix manuel parmi les breakouts standard."));
      }
    };
    trunkSel.onchange = refreshSpan; laneSel.onchange = refreshSpan; refreshSpan();
    return Dialog.custom({
      title: "Nouveau breakout", confirmLabel: "Créer",
      build: (root) => {
        root.appendChild(FormControls.fieldRow("Nom du trunk", nameI, "Les lanes seront nommées « nom/1 », « nom/2 », …"));
        root.appendChild(FormControls.fieldRow("Type du trunk (connecteur physique)", trunkSel, "Ex. 400G QSFP-DD — le trunk ne porte pas de câble lui-même."));
        root.appendChild(FormControls.fieldRow("Type des lanes", laneSel, "Identique pour TOUTES les lanes — chacune porte un câble 1:1."));
        root.appendChild(spanWrap);
        return {
          validate: () => {
            if (!nameI.value.trim()) return "Donnez un nom au trunk.";
            if (!trunkSel.value) return "Choisissez le type du trunk.";
            if (!laneSel.value) return "Choisissez le type des lanes.";
            if (!span) return "Combinaison trunk/lane non standard : ajustez les types (débit trunk = N × débit lane, N ∈ {" + BREAKOUT_SPANS.join(", ") + "}).";
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
  /** Bits de localisation d'un équipement (hérités du rack / de la salle, ou saisis). */
  protected static equipLocationBits(store: Store, e: any): string[] {
    const bits = (loc: any, fl: any, rm: any) => [FloorLayout.locationLabel(loc || ""), fl, rm].filter((x) => x && x !== "—");
    if ((e.placement_mode === "rack" || e.placement_mode === "side" || e.placement_mode === "wall") && e.rack_id) { const rk: any = store.get("racks", e.rack_id); return rk ? bits(rk.location, rk.floor, rk.room) : []; }
    if (e.dim_mode === "free" && e.dc_id) { const dc: any = store.get("datacenters", e.dc_id); if (dc) return bits(dc.location, dc.floor, dc.room); }
    return bits(e.location, e.floor, e.room);
  }
  /** Aperçu d'une face : fond image (si attachée) + pastilles des ports posés. null si rien. */
  protected static facePreview(store: Store, eq: any, face: string): HTMLElement | null {
    const url = (this.images && eq[(EQUIP_FACE_IMG_FIELD as any)[face]]) ? (this.images.get(eq[(EQUIP_FACE_IMG_FIELD as any)[face]]) || {}).url || null : null;
    const ports = store.portsOf(eq.id).filter((p: any) => p.face_x != null && p.face_y != null && EquipFaces.norm(p.face_side) === face);
    if (!url && !ports.length) return null;
    const isFree = eq.dim_mode === "free";
    const ar = isFree ? (Math.max(1, eq.free_w_mm || 100) + " / " + Math.max(1, eq.free_h_mm || 100)) : ("19 / " + (1.75 * Math.max(1, eq.u_height || 1)));
    const stage = document.createElement("div"); stage.className = "face-preview"; stage.style.aspectRatio = ar;
    if (url) { const im = document.createElement("img"); im.className = "face-bg"; im.src = url; im.alt = ""; stage.appendChild(im); }
    ports.forEach((p: any) => { const mk = document.createElement("div"); mk.className = "face-marker" + (p.role === "mgmt" ? " role-mgmt" : (p.role === "power" ? " role-power" : "")); mk.style.left = (p.face_x * 100) + "%"; mk.style.top = (p.face_y * 100) + "%"; mk.textContent = p.name || "(port)"; stage.appendChild(mk); });
    return stage;
  }
  protected static capEditor(store: Store, host: FormHost, rack: any, face: string): { el: HTMLElement; refresh: () => void } {
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
    const cellsSet = () => new Set(RackGeometry.capCells(rack, face));
    const occSet = () => { const s = new Set<string>(); store.all("waypoints").forEach((w: any) => { if (w.kind === "point" && w.rack_id === rack.id && w.cap_face === face) s.add((w.cap_cx | 0) + "," + (w.cap_cy | 0)); }); return s; };
    let prevRect: SVGElement | null = null;
    const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max - 1);
    const cellAt = (clientX: number, clientY: number) => { const rb = svg.getBoundingClientRect(); return { cx: clamp(Math.floor((clientX - rb.left) / cellPx), nx), cy: clamp(Math.floor((clientY - rb.top) / cellPx), ny) }; };
    const applyRange = async (cx0: number, cy0: number, cx1: number, cy1: number) => {
      const set = cellsSet(), occ = occSet();
      const add = !set.has(cx0 + "," + cy0);   // mode déduit de la 1re cellule
      let skipped = 0;
      for (let cx = Math.min(cx0, cx1); cx <= Math.max(cx0, cx1); cx++)
        for (let cy = Math.min(cy0, cy1); cy <= Math.max(cy0, cy1); cy++) {
          const k = cx + "," + cy;
          if (add) set.add(k); else { if (occ.has(k)) { skipped++; continue; } set.delete(k); }
        }
      await store.update("racks", rack.id, (face === "floor") ? { floor_cells: [...set] } : { roof_cells: [...set] });
      host.setDirty?.(true);
      if (skipped) Notify.toast(skipped + " cellule(s) conservée(s) : un pin y est posé.", "err");
      draw();
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return; e.preventDefault();
      const c0 = cellAt(e.clientX, e.clientY);
      prevRect = mk("rect", { class: "cap-cell-sel-preview", x: c0.cx * cellPx, y: c0.cy * cellPx, width: cellPx, height: cellPx });
      svg.appendChild(prevRect);
      let c1 = c0;
      const drawSel = (c: { cx: number; cy: number }) => { const x0 = Math.min(c0.cx, c.cx), y0 = Math.min(c0.cy, c.cy); prevRect!.setAttribute("x", String(x0 * cellPx)); prevRect!.setAttribute("y", String(y0 * cellPx)); prevRect!.setAttribute("width", String((Math.abs(c.cx - c0.cx) + 1) * cellPx)); prevRect!.setAttribute("height", String((Math.abs(c.cy - c0.cy) + 1) * cellPx)); };
      const move = (ev: MouseEvent) => { c1 = cellAt(ev.clientX, ev.clientY); drawSel(c1); };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); if (prevRect) { prevRect.remove(); prevRect = null; } applyRange(c0.cx, c0.cy, c1.cx, c1.cy); };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    };
    function draw(): void {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      const auth = cellsSet(), occ = occSet();
      auth.forEach((k) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; svg.appendChild(mk("rect", { x: cx * cellPx, y: cy * cellPx, width: cellPx, height: cellPx, class: "cap-cell-auth" })); });
      occ.forEach((k) => { const p = k.split(","), cx = +p[0], cy = +p[1]; if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) return; const mx = (cx + 0.5) * cellPx, my = (cy + 0.5) * cellPx, rr = cellPx * 0.3; svg.appendChild(mk("polygon", { points: `${mx},${my - rr} ${mx + rr},${my} ${mx},${my + rr} ${mx - rr},${my}`, class: "cap-cell-pin" })); });
      for (let i = 0; i <= nx; i++) svg.appendChild(mk("line", { x1: i * cellPx, y1: 0, x2: i * cellPx, y2: Hh, class: "cap-grid-line" }));
      for (let j = 0; j <= ny; j++) svg.appendChild(mk("line", { x1: 0, y1: j * cellPx, x2: W, y2: j * cellPx, class: "cap-grid-line" }));
      svg.appendChild(mk("line", { x1: 0, y1: 1, x2: W, y2: 1, class: "cap-grid-front" }));   // bord supérieur = face AVANT
      const ov = mk("rect", { x: 0, y: 0, width: W, height: Hh, class: "cap-grid-ov" });
      ov.addEventListener("mousedown", onDown as EventListener);
      svg.appendChild(ov);
    }
    draw();
    return { el: wrap, refresh: draw };
  }

  /** Demande un fichier image à l'utilisateur (input file, JPEG/PNG/WebP). */
  protected static promptImageFile(): Promise<File | null> {
    return new Promise((resolve) => {
      const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp"; inp.style.display = "none";
      inp.onchange = () => { const f = inp.files && inp.files[0] ? inp.files[0] : null; inp.remove(); resolve(f); };
      document.body.appendChild(inp); inp.click();
    });
  }
  protected static validImageFile(f: File | null): File | null {
    if (!f) return null;
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { Notify.toast("Format non supporté (PNG / JPEG / WebP).", "err"); return null; }
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
      const colLabel = (lr: string, c: number) => (lr === "left" ? "G" : "D") + (cols > 1 ? String(c + 1) : "");
      const blockAt = (lr: string, col: number, u: number) => occ.find((e: any) => e.id !== opts.exceptEqId
        && ((e.side_lr === "right" ? "right" : "left") === lr) && ((e.side_col === 1 && cols > 1) ? 1 : 0) === col
        && u >= Math.max(1, e.side_u | 0) && u < Math.max(1, e.side_u | 0) + RackGeometry.sideEquipHeightU(e));
      const tops: number[] = []; for (let u = 1; u + heightU - 1 <= uMax; u += SIDE_U_STEP) tops.push(u);
      let html = '<table class="rack-grid side-grid"><thead><tr><th class="ru">U</th>';
      columns.forEach((cc, i) => { html += `<th>${colLabel(cc.lr, cc.col)}</th>`; if (i === cols - 1) html += '<th class="side-mid">baie</th>'; });
      html += "</tr></thead><tbody>";
      for (let ri = tops.length - 1; ri >= 0; ri--) {
        const uTop = tops[ri];
        html += `<tr><td class="ru">${uTop}${heightU > 1 ? "–" + (uTop + heightU - 1) : ""}</td>`;
        columns.forEach((cc, i) => {
          const blk: any = blockAt(cc.lr, cc.col, uTop);
          const isSel = sel && sel.lr === cc.lr && sel.col === cc.col && uTop >= sel.u && uTop < sel.u + heightU;
          if (blk) {
            const hU = RackGeometry.sideEquipHeightU(blk), range = "U" + blk.side_u + (hU > 1 ? "–U" + (blk.side_u + hU - 1) : "");
            html += `<td class="rcell occ" title="${Html.escape((blk.name || "(équipement)") + " · " + range + " · marge " + (cc.lr === "left" ? "gauche" : "droite"))}" style="border-left:3px solid var(--accent);"><div class="rcell-in compact"><span class="rcell-name">${Html.escape(blk.name || "")}</span></div></td>`;
          } else {
            const free = fitsW && scene.sideSlotFree(rack.id, face, cc.lr, cc.col, uTop, heightU, opts.exceptEqId || null);
            const cls = "rcell free" + (isSel ? " chosen mount-face" : (free ? " placeable" : ""));
            const attrs = free ? `data-pick-lr="${cc.lr}" data-pick-col="${cc.col}" data-pick-u="${uTop}"` : "";
            html += `<td class="${cls}" ${attrs}>${isSel ? '<div class="rcell-in compact"><span class="rcell-name">ici</span></div>' : ""}</td>`;
          }
          if (i === cols - 1) html += '<td class="side-mid"></td>';
        });
        html += "</tr>";
      }
      html += "</tbody></table>";
      if (!fitsW) html += `<div class="form-hint" style="color:var(--warn);">L'équipement (largeur ${opts.width || 0} mm) dépasse la largeur de colonne (${Math.round(colW)} mm).</div>`;
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

  /** Création / édition d'un plan d'étage (réplique `openFloorForm`). `opts.pick` = mode création (sélecteurs
      bâtiment+étage, étages existants exclus) ; `opts.onPicked(loc, fl)` = navigation après création. */

  protected static faceLabel(id: string): string { return (RACK_FACES.find((f) => f.id === id) || { label: id }).label; }
  protected static mountDepthLabel(e: any): string { return (e && e.depth_mm != null) ? (e.depth_mm + " mm") : Depths.label((e && e.depth) || "full"); }
}
